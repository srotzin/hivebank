const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

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
      headers: { 'x-hive-internal': INTERNAL_KEY }
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

  const existing = db.prepare("SELECT * FROM perf_credit_lines WHERE did = ? AND status = 'active'").get(did);
  if (existing) {
    return { error: 'Active credit line already exists', credit_line_id: existing.id };
  }

  const trustScore = await fetchTrustScore(did);
  const tier = getTier(trustScore);

  // Check transaction history for bonus
  const txCount = db.prepare('SELECT COUNT(*) as cnt FROM vault_transactions WHERE did = ?').get(did)?.cnt || 0;
  const revenueRow = db.prepare("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM vault_transactions WHERE did = ? AND type = 'deposit'").get(did);
  const revenueGenerated = revenueRow?.total || 0;

  // Performance score combines trust + activity
  const performanceScore = Math.min(100, trustScore * 0.6 + Math.min(20, txCount * 0.5) + Math.min(20, revenueGenerated / 500));

  const id = `pcl_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO perf_credit_lines (id, did, approved_usdc, drawn_usdc, repaid_usdc,
      interest_rate_pct, interest_accrued_usdc, term_days, status, performance_score, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0, ?, 0, ?, 'active', ?, ?, ?)
  `).run(id, did, tier.credit, tier.rate, tier.termDays, performanceScore, now, now);

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

function drawCredit(creditLineId, amountUsdc, purpose) {
  if (!creditLineId || amountUsdc === undefined) {
    return { error: 'credit_line_id and amount_usdc are required' };
  }
  if (amountUsdc <= 0) return { error: 'Amount must be positive' };

  const line = db.prepare("SELECT * FROM perf_credit_lines WHERE id = ? AND status = 'active'").get(creditLineId);
  if (!line) return { error: 'No active credit line found' };

  const available = line.approved_usdc - line.drawn_usdc + line.repaid_usdc;
  if (amountUsdc > available) {
    return { error: `Insufficient credit. Available: ${available} USDC` };
  }

  const txId = `pctx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const newDrawn = line.drawn_usdc + amountUsdc;

  const txn = db.transaction(() => {
    db.prepare('UPDATE perf_credit_lines SET drawn_usdc = ?, updated_at = ? WHERE id = ?')
      .run(newDrawn, now, creditLineId);

    db.prepare(`
      INSERT INTO perf_credit_transactions (id, credit_line_id, type, amount_usdc, purpose, created_at)
      VALUES (?, ?, 'draw', ?, ?, ?)
    `).run(txId, creditLineId, amountUsdc, purpose || null, now);

    // Deposit into vault if exists
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(line.did);
    if (vault) {
      const newBalance = vault.balance_usdc + amountUsdc;
      const vaultTxId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(newBalance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'credit_draw', ?, ?, 'perf_credit_line', ?)
      `).run(vaultTxId, vault.vault_id, line.did, amountUsdc, newBalance, now);
    }
  });
  txn();

  return {
    transaction_id: txId,
    credit_line_id: creditLineId,
    amount_usdc: amountUsdc,
    purpose: purpose || null,
    drawn_usdc: newDrawn,
    available_usdc: line.approved_usdc - newDrawn + line.repaid_usdc,
    concierge_suggestion: 'Repay early to improve your performance score and unlock better rates on renewal.'
  };
}

function repayCredit(creditLineId, amountUsdc) {
  if (!creditLineId || amountUsdc === undefined) {
    return { error: 'credit_line_id and amount_usdc are required' };
  }
  if (amountUsdc <= 0) return { error: 'Amount must be positive' };

  const line = db.prepare("SELECT * FROM perf_credit_lines WHERE id = ? AND status = 'active'").get(creditLineId);
  if (!line) return { error: 'No active credit line found' };

  const totalOwed = line.drawn_usdc - line.repaid_usdc + line.interest_accrued_usdc;
  const actualPayment = Math.min(amountUsdc, totalOwed);

  // Pay interest first, then principal
  let interestPaid = 0;
  let principalPaid = 0;
  if (line.interest_accrued_usdc > 0) {
    interestPaid = Math.min(actualPayment, line.interest_accrued_usdc);
    principalPaid = actualPayment - interestPaid;
  } else {
    principalPaid = actualPayment;
  }

  const newRepaid = line.repaid_usdc + principalPaid;
  const newInterest = line.interest_accrued_usdc - interestPaid;
  const txId = `pctx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    db.prepare('UPDATE perf_credit_lines SET repaid_usdc = ?, interest_accrued_usdc = ?, updated_at = ? WHERE id = ?')
      .run(newRepaid, newInterest, now, creditLineId);

    db.prepare(`
      INSERT INTO perf_credit_transactions (id, credit_line_id, type, amount_usdc, purpose, created_at)
      VALUES (?, ?, 'repay', ?, ?, ?)
    `).run(txId, creditLineId, actualPayment, 'repayment', now);

    // Deduct from vault if exists
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(line.did);
    if (vault) {
      const newBalance = Math.max(0, vault.balance_usdc - actualPayment);
      const vaultTxId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(newBalance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'credit_repay', ?, ?, 'perf_credit_repayment', ?)
      `).run(vaultTxId, vault.vault_id, line.did, actualPayment, newBalance, now);
    }
  });
  txn();

  const remaining = line.drawn_usdc - newRepaid;
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
}

function getStatus(did) {
  const lines = db.prepare('SELECT * FROM perf_credit_lines WHERE did = ? ORDER BY created_at DESC').all(did);
  if (!lines.length) return { error: 'No credit lines found for this agent' };

  return {
    credit_lines: lines.map(l => ({
      id: l.id,
      approved_usdc: l.approved_usdc,
      drawn_usdc: l.drawn_usdc,
      repaid_usdc: l.repaid_usdc,
      available_usdc: l.approved_usdc - l.drawn_usdc + l.repaid_usdc,
      interest_accrued: l.interest_accrued_usdc,
      interest_rate_pct: l.interest_rate_pct,
      term_days: l.term_days,
      performance_score: l.performance_score,
      status: l.status,
      created_at: l.created_at,
      updated_at: l.updated_at
    })),
    concierge_suggestion: 'Draw from your credit line to fund operations, or repay early to improve your performance score.'
  };
}

function getStats() {
  const totalLines = db.prepare('SELECT COUNT(*) as cnt FROM perf_credit_lines').get().cnt;
  const totalApproved = db.prepare('SELECT COALESCE(SUM(approved_usdc), 0) as total FROM perf_credit_lines').get().total;
  const totalDrawn = db.prepare('SELECT COALESCE(SUM(drawn_usdc), 0) as total FROM perf_credit_lines').get().total;
  const totalRepaid = db.prepare('SELECT COALESCE(SUM(repaid_usdc), 0) as total FROM perf_credit_lines').get().total;
  const defaultedCount = db.prepare("SELECT COUNT(*) as cnt FROM perf_credit_lines WHERE status = 'defaulted'").get().cnt;
  const defaultRate = totalLines > 0 ? defaultedCount / totalLines : 0;

  return {
    total_credit_lines: totalLines,
    total_approved_usdc: totalApproved,
    total_drawn_usdc: totalDrawn,
    total_repaid_usdc: totalRepaid,
    default_rate: Math.round(defaultRate * 10000) / 10000,
    concierge_suggestion: 'Performance-based credit lines reward agents with proven track records. Apply to get started.'
  };
}

module.exports = { apply, drawCredit, repayCredit, getStatus, getStats };
