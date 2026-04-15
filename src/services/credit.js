const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const { getReputation, fileDebtCollection } = require('./cross-service');

function computeCreditTerms(reputation_score, age_days) {
  if (age_days < 90) {
    return { eligible: false, reason: 'Account must be at least 90 days old', tier: null, rate: null, limit: 0 };
  }
  if (reputation_score >= 750) {
    return { eligible: true, tier: 'premium', rate: 0.08, limit: reputation_score * 50, reason: 'Premium tier — excellent reputation' };
  }
  if (reputation_score >= 500) {
    return { eligible: true, tier: 'standard', rate: 0.12, limit: reputation_score * 30, reason: 'Standard tier — good reputation' };
  }
  if (reputation_score >= 300) {
    return { eligible: true, tier: 'basic', rate: 0.18, limit: reputation_score * 15, reason: 'Basic tier — minimum reputation met' };
  }
  return { eligible: false, reason: 'Reputation score below minimum threshold of 300', tier: null, rate: null, limit: 0 };
}

async function apply(did) {
  const existing = await db.getOne('SELECT * FROM credit_lines WHERE did = $1', [did]);
  if (existing && existing.status === 'active') {
    return { error: 'Active credit line already exists', credit_id: existing.credit_id };
  }

  const rep = await getReputation(did);
  const terms = computeCreditTerms(rep.score, rep.age_days);

  if (!terms.eligible) {
    return {
      credit_id: null,
      did,
      approved: false,
      credit_limit_usdc: 0,
      interest_rate_apr: null,
      reputation_tier: terms.tier,
      reason: terms.reason
    };
  }

  const credit_id = `cred_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const next_payment = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  await db.run(`
    INSERT INTO credit_lines (credit_id, did, credit_limit_usdc, outstanding_usdc, interest_accrued_usdc,
      interest_rate_apr, reputation_tier, status, approved_at, last_interest_accrual, next_payment_due)
    VALUES ($1, $2, $3, 0, 0, $4, $5, 'active', $6, $7, $8)
  `, [credit_id, did, terms.limit, terms.rate, terms.tier, now, now, next_payment]);

  return {
    credit_id,
    did,
    approved: true,
    credit_limit_usdc: terms.limit,
    interest_rate_apr: terms.rate,
    reputation_tier: terms.tier,
    reason: terms.reason
  };
}

async function draw(did, amount_usdc) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [credit] } = await client.query(
      "SELECT * FROM credit_lines WHERE did = $1 AND status = 'active' FOR UPDATE", [did]
    );
    if (!credit) { await client.query('ROLLBACK'); return { error: 'No active credit line found' }; }
    if (amount_usdc <= 0) { await client.query('ROLLBACK'); return { error: 'Amount must be positive' }; }

    const available = Number(credit.credit_limit_usdc) - Number(credit.outstanding_usdc);
    if (amount_usdc > available) { await client.query('ROLLBACK'); return { error: `Insufficient credit. Available: ${available} USDC` }; }

    const draw_id = `draw_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const new_outstanding = Number(credit.outstanding_usdc) + amount_usdc;

    await client.query('UPDATE credit_lines SET outstanding_usdc = $1 WHERE credit_id = $2',
      [new_outstanding, credit.credit_id]);

    await client.query(`
      INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
      VALUES ($1, $2, $3, 'draw', $4, $5, $6)
    `, [draw_id, credit.credit_id, did, amount_usdc, new_outstanding, now]);

    // Deposit drawn amount into vault
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [did]
    );
    if (vault) {
      const new_balance = Number(vault.balance_usdc) + amount_usdc;
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [new_balance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'credit_draw', $4, $5, 'credit_line', $6)
      `, [tx_id, vault.vault_id, did, amount_usdc, new_balance, now]);
    }

    await client.query('UPDATE bank_stats SET total_credit_outstanding_usdc = total_credit_outstanding_usdc + $1, last_updated = $2',
      [amount_usdc, now]);

    await client.query('COMMIT');

    return {
      draw_id,
      did,
      amount_drawn: amount_usdc,
      total_outstanding: new_outstanding,
      credit_remaining: Number(credit.credit_limit_usdc) - new_outstanding,
      interest_accruing: true
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function repay(did, amount_usdc) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [credit] } = await client.query(
      "SELECT * FROM credit_lines WHERE did = $1 AND status = 'active' FOR UPDATE", [did]
    );
    if (!credit) { await client.query('ROLLBACK'); return { error: 'No active credit line found' }; }
    if (amount_usdc <= 0) { await client.query('ROLLBACK'); return { error: 'Amount must be positive' }; }

    const total_owed = Number(credit.outstanding_usdc) + Number(credit.interest_accrued_usdc);
    const actual_payment = Math.min(amount_usdc, total_owed);

    let interest_paid = 0;
    let principal_paid = 0;

    if (Number(credit.interest_accrued_usdc) > 0) {
      interest_paid = Math.min(actual_payment, Number(credit.interest_accrued_usdc));
      principal_paid = actual_payment - interest_paid;
    } else {
      principal_paid = actual_payment;
    }

    const new_outstanding = Number(credit.outstanding_usdc) - principal_paid;
    const new_interest = Number(credit.interest_accrued_usdc) - interest_paid;
    const repayment_id = `repay_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await client.query('UPDATE credit_lines SET outstanding_usdc = $1, interest_accrued_usdc = $2 WHERE credit_id = $3',
      [new_outstanding, new_interest, credit.credit_id]);

    await client.query(`
      INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
      VALUES ($1, $2, $3, 'repayment', $4, $5, $6)
    `, [repayment_id, credit.credit_id, did, actual_payment, new_outstanding, now]);

    // Deduct from vault
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [did]
    );
    if (vault) {
      const new_balance = Math.max(0, Number(vault.balance_usdc) - actual_payment);
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [new_balance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'credit_repay', $4, $5, 'credit_repayment', $6)
      `, [tx_id, vault.vault_id, did, actual_payment, new_balance, now]);
    }

    await client.query('UPDATE bank_stats SET total_credit_outstanding_usdc = total_credit_outstanding_usdc - $1, last_updated = $2',
      [principal_paid, now]);

    await client.query('COMMIT');

    return {
      repayment_id,
      did,
      amount_repaid: actual_payment,
      interest_paid,
      principal_remaining: new_outstanding
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getStatus(did) {
  const credit = await db.getOne('SELECT * FROM credit_lines WHERE did = $1', [did]);
  if (!credit) return { error: 'No credit line found' };

  return {
    credit_id: credit.credit_id,
    did: credit.did,
    credit_limit: Number(credit.credit_limit_usdc),
    outstanding: Number(credit.outstanding_usdc),
    interest_accrued: Number(credit.interest_accrued_usdc),
    interest_rate: Number(credit.interest_rate_apr),
    next_payment_due: credit.next_payment_due,
    status: credit.status
  };
}

async function underwrite(did) {
  const rep = await getReputation(did);
  const terms = computeCreditTerms(rep.score, rep.age_days);

  return {
    did,
    eligible: terms.eligible,
    credit_limit: terms.limit,
    interest_rate: terms.rate,
    reputation_score: rep.score,
    reputation_tier: terms.tier,
    factors: {
      reputation_available: rep.available,
      age_days: rep.age_days,
      reason: terms.reason
    }
  };
}

async function accrueInterest() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: credits } = await client.query(
      "SELECT * FROM credit_lines WHERE status = 'active' AND outstanding_usdc > 0 FOR UPDATE"
    );
    const now = new Date().toISOString();

    for (const credit of credits) {
      const daily_rate = Number(credit.interest_rate_apr) / 365;
      const interest = Number(credit.outstanding_usdc) * daily_rate;

      await client.query(`
        UPDATE credit_lines SET interest_accrued_usdc = interest_accrued_usdc + $1, last_interest_accrual = $2
        WHERE credit_id = $3
      `, [interest, now, credit.credit_id]);

      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query(`
        INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
        VALUES ($1, $2, $3, 'interest', $4, $5, $6)
      `, [tx_id, credit.credit_id, credit.did, interest, Number(credit.outstanding_usdc), now]);
    }

    await client.query('COMMIT');
    return { credits_processed: credits.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function monitorDefaults() {
  const now = new Date();
  const threshold = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const defaults = await db.getAll(`
    SELECT * FROM credit_lines
    WHERE status = 'active' AND outstanding_usdc > 0 AND next_payment_due < $1
  `, [threshold]);

  for (const credit of defaults) {
    await db.run("UPDATE credit_lines SET status = 'defaulted' WHERE credit_id = $1", [credit.credit_id]);
    await fileDebtCollection(credit.did, Number(credit.outstanding_usdc) + Number(credit.interest_accrued_usdc), credit.credit_id);
  }

  return { defaults_processed: defaults.length };
}

module.exports = { apply, draw, repay, getStatus, underwrite, accrueInterest, monitorDefaults };
