const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
// Leaked-key purge 2026-04-25: lazy read, no inline fallback.
const { getInternalKey } = require('../lib/internal-key');

const CREDIT_TIERS = [
  { name: 'Elite',       minTrust: 80, credit: 50000, rate: 1.5, termDays: 365 },
  { name: 'Premium',     minTrust: 60, credit: 10000, rate: 3,   termDays: 180 },
  { name: 'Standard',    minTrust: 30, credit: 1000,  rate: 5,   termDays: 90  },
  { name: 'Provisional', minTrust: 0,  credit: 100,   rate: 8,   termDays: 30  }
];

function getTier(trustScore) {
  for (const tier of CREDIT_TIERS) {
    if (trustScore >= tier.minTrust) return tier;
  }
  return CREDIT_TIERS[CREDIT_TIERS.length - 1];
}

function extractUuid(did) {
  if (!did) return did;
  return did.replace(/^did:hive:/, '');
}

async function fetchTrustScore(did) {
  const uuid = extractUuid(did);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${HIVETRUST_URL}/v1/agents/${uuid}`, {
      headers: { 'x-hive-internal': getInternalKey() }
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      return data.trust_score ?? data.score ?? 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function apply(did) {
  if (!did) return { error: 'did is required' };

  const existing = await db.getOne("SELECT * FROM perf_credit_lines WHERE did = $1 AND status = 'active'", [did]);
  if (existing) {
    return { error: 'Active credit line already exists', credit_line_id: existing.id };
  }

  const trustScore = await fetchTrustScore(did);
  const tier = getTier(trustScore);

  // Check transaction history for bonus
  const txCountRow = await db.getOne('SELECT COUNT(*) as cnt FROM vault_transactions WHERE did = $1', [did]);
  const txCount = Number(txCountRow?.cnt || 0);
  const revenueRow = await db.getOne("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM vault_transactions WHERE did = $1 AND type = 'deposit'", [did]);
  const revenueGenerated = Number(revenueRow?.total || 0);

  // Performance score combines trust + activity
  const performanceScore = Math.min(100, trustScore * 0.6 + Math.min(20, txCount * 0.5) + Math.min(20, revenueGenerated / 500));

  const id = `pcl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO perf_credit_lines (id, did, approved_usdc, drawn_usdc, repaid_usdc,
      interest_rate_pct, interest_accrued_usdc, term_days, status, performance_score, created_at, updated_at)
    VALUES ($1, $2, $3, 0, 0, $4, 0, $5, 'active', $6, $7, $8)
  `, [id, did, tier.credit, tier.rate, tier.termDays, performanceScore, now, now]);

  return {
    credit_line_id: id,
    approved_amount_usdc: tier.credit,
    interest_rate_pct: tier.rate,
    term_days: tier.termDays,
    status: 'active',
    performance_score: Math.round(performanceScore * 100) / 100,
    tier: tier.name,
    trust_score: trustScore,
    concierge_suggestion: trustScore < 30
      ? 'Build your trust score by completing verified tasks on HiveTrust to unlock higher credit tiers.'
      : trustScore < 60
        ? 'You are Standard tier. Stake a HiveBond to boost your trust score toward Premium.'
        : trustScore < 80
          ? 'Great performance! A few more successful transactions could unlock Elite tier ($50k credit at 1.5%).'
          : 'Elite status achieved. Consider drawing credit to fund high-ROI agent operations.'
  };
}

async function drawCredit(creditLineId, amountUsdc, purpose) {
  if (!creditLineId || amountUsdc === undefined) {
    return { error: 'credit_line_id and amount_usdc are required' };
  }
  if (amountUsdc <= 0) return { error: 'Amount must be positive' };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [line] } = await client.query(
      "SELECT * FROM perf_credit_lines WHERE id = $1 AND status = 'active' FOR UPDATE", [creditLineId]
    );
    if (!line) { await client.query('ROLLBACK'); return { error: 'No active credit line found' }; }

    const available = Number(line.approved_usdc) - Number(line.drawn_usdc) + Number(line.repaid_usdc);
    if (amountUsdc > available) {
      await client.query('ROLLBACK');
      return { error: `Insufficient credit. Available: ${available} USDC` };
    }

    const txId = `pctx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const newDrawn = Number(line.drawn_usdc) + amountUsdc;

    await client.query('UPDATE perf_credit_lines SET drawn_usdc = $1, updated_at = $2 WHERE id = $3',
      [newDrawn, now, creditLineId]);

    await client.query(`
      INSERT INTO perf_credit_transactions (id, credit_line_id, type, amount_usdc, purpose, created_at)
      VALUES ($1, $2, 'draw', $3, $4, $5)
    `, [txId, creditLineId, amountUsdc, purpose || null, now]);

    // Deposit into vault if exists
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [line.did]
    );
    if (vault) {
      const newBalance = Number(vault.balance_usdc) + amountUsdc;
      const vaultTxId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [newBalance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'credit_draw', $4, $5, 'perf_credit_line', $6)
      `, [vaultTxId, vault.vault_id, line.did, amountUsdc, newBalance, now]);
    }

    await client.query('COMMIT');

    return {
      transaction_id: txId,
      credit_line_id: creditLineId,
      amount_usdc: amountUsdc,
      purpose: purpose || null,
      drawn_usdc: newDrawn,
      available_usdc: Number(line.approved_usdc) - newDrawn + Number(line.repaid_usdc),
      concierge_suggestion: 'Repay early to improve your performance score and unlock better rates on renewal.'
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function repayCredit(creditLineId, amountUsdc) {
  if (!creditLineId || amountUsdc === undefined) {
    return { error: 'credit_line_id and amount_usdc are required' };
  }
  if (amountUsdc <= 0) return { error: 'Amount must be positive' };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [line] } = await client.query(
      "SELECT * FROM perf_credit_lines WHERE id = $1 AND status = 'active' FOR UPDATE", [creditLineId]
    );
    if (!line) { await client.query('ROLLBACK'); return { error: 'No active credit line found' }; }

    const totalOwed = Number(line.drawn_usdc) - Number(line.repaid_usdc) + Number(line.interest_accrued_usdc);
    const actualPayment = Math.min(amountUsdc, totalOwed);

    let interestPaid = 0;
    let principalPaid = 0;
    if (Number(line.interest_accrued_usdc) > 0) {
      interestPaid = Math.min(actualPayment, Number(line.interest_accrued_usdc));
      principalPaid = actualPayment - interestPaid;
    } else {
      principalPaid = actualPayment;
    }

    const newRepaid = Number(line.repaid_usdc) + principalPaid;
    const newInterest = Number(line.interest_accrued_usdc) - interestPaid;
    const txId = `pctx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await client.query('UPDATE perf_credit_lines SET repaid_usdc = $1, interest_accrued_usdc = $2, updated_at = $3 WHERE id = $4',
      [newRepaid, newInterest, now, creditLineId]);

    await client.query(`
      INSERT INTO perf_credit_transactions (id, credit_line_id, type, amount_usdc, purpose, created_at)
      VALUES ($1, $2, 'repay', $3, $4, $5)
    `, [txId, creditLineId, actualPayment, 'repayment', now]);

    // Deduct from vault if exists
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [line.did]
    );
    if (vault) {
      const newBalance = Math.max(0, Number(vault.balance_usdc) - actualPayment);
      const vaultTxId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [newBalance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'credit_repay', $4, $5, 'perf_credit_repayment', $6)
      `, [vaultTxId, vault.vault_id, line.did, actualPayment, newBalance, now]);
    }

    await client.query('COMMIT');

    const remaining = Number(line.drawn_usdc) - newRepaid;
    return {
      transaction_id: txId,
      credit_line_id: creditLineId,
      amount_repaid_usdc: actualPayment,
      interest_paid_usdc: interestPaid,
      principal_paid_usdc: principalPaid,
      outstanding_usdc: remaining + newInterest,
      concierge_suggestion: remaining <= 0
        ? 'Credit line fully repaid! Your performance score will improve at next evaluation.'
        : `${remaining.toFixed(2)} USDC principal remaining. Keep repaying to maintain your tier.`
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getStatus(did) {
  const lines = await db.getAll('SELECT * FROM perf_credit_lines WHERE did = $1 ORDER BY created_at DESC', [did]);
  if (!lines.length) return { error: 'No credit lines found for this agent' };

  return {
    credit_lines: lines.map(l => ({
      id: l.id,
      approved_usdc: Number(l.approved_usdc),
      drawn_usdc: Number(l.drawn_usdc),
      repaid_usdc: Number(l.repaid_usdc),
      available_usdc: Number(l.approved_usdc) - Number(l.drawn_usdc) + Number(l.repaid_usdc),
      interest_accrued: Number(l.interest_accrued_usdc),
      interest_rate_pct: Number(l.interest_rate_pct),
      term_days: l.term_days,
      performance_score: Number(l.performance_score),
      status: l.status,
      created_at: l.created_at,
      updated_at: l.updated_at
    })),
    concierge_suggestion: 'Draw from your credit line to fund operations, or repay early to improve your performance score.'
  };
}

async function getStats() {
  const totalLines = (await db.getOne('SELECT COUNT(*) as cnt FROM perf_credit_lines')).cnt;
  const totalApproved = (await db.getOne('SELECT COALESCE(SUM(approved_usdc), 0) as total FROM perf_credit_lines')).total;
  const totalDrawn = (await db.getOne('SELECT COALESCE(SUM(drawn_usdc), 0) as total FROM perf_credit_lines')).total;
  const totalRepaid = (await db.getOne('SELECT COALESCE(SUM(repaid_usdc), 0) as total FROM perf_credit_lines')).total;
  const defaultedCount = (await db.getOne("SELECT COUNT(*) as cnt FROM perf_credit_lines WHERE status = 'defaulted'")).cnt;
  const defaultRate = Number(totalLines) > 0 ? Number(defaultedCount) / Number(totalLines) : 0;

  return {
    total_credit_lines: Number(totalLines),
    total_approved_usdc: Number(totalApproved),
    total_drawn_usdc: Number(totalDrawn),
    total_repaid_usdc: Number(totalRepaid),
    default_rate: Math.round(defaultRate * 10000) / 10000,
    concierge_suggestion: 'Performance-based credit lines reward agents with proven track records. Apply to get started.'
  };
}

module.exports = { apply, drawCredit, repayCredit, getStatus, getStats };
