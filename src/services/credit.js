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
  const existing = db.prepare('SELECT * FROM credit_lines WHERE did = ?').get(did);
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

  db.prepare(`
    INSERT INTO credit_lines (credit_id, did, credit_limit_usdc, outstanding_usdc, interest_accrued_usdc,
      interest_rate_apr, reputation_tier, status, approved_at, last_interest_accrual, next_payment_due)
    VALUES (?, ?, ?, 0, 0, ?, ?, 'active', ?, ?, ?)
  `).run(credit_id, did, terms.limit, terms.rate, terms.tier, now, now, next_payment);

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

function draw(did, amount_usdc) {
  const credit = db.prepare("SELECT * FROM credit_lines WHERE did = ? AND status = 'active'").get(did);
  if (!credit) return { error: 'No active credit line found' };
  if (amount_usdc <= 0) return { error: 'Amount must be positive' };

  const available = credit.credit_limit_usdc - credit.outstanding_usdc;
  if (amount_usdc > available) return { error: `Insufficient credit. Available: ${available} USDC` };

  const draw_id = `draw_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();
  const new_outstanding = credit.outstanding_usdc + amount_usdc;

  const txn = db.transaction(() => {
    db.prepare('UPDATE credit_lines SET outstanding_usdc = ? WHERE credit_id = ?')
      .run(new_outstanding, credit.credit_id);

    db.prepare(`
      INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
      VALUES (?, ?, ?, 'draw', ?, ?, ?)
    `).run(draw_id, credit.credit_id, did, amount_usdc, new_outstanding, now);

    // Deposit drawn amount into vault
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
    if (vault) {
      const new_balance = vault.balance_usdc + amount_usdc;
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(new_balance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'credit_draw', ?, ?, 'credit_line', ?)
      `).run(tx_id, vault.vault_id, did, amount_usdc, new_balance, now);
    }

    db.prepare('UPDATE bank_stats SET total_credit_outstanding_usdc = total_credit_outstanding_usdc + ?, last_updated = ?')
      .run(amount_usdc, now);
  });
  txn();

  return {
    draw_id,
    did,
    amount_drawn: amount_usdc,
    total_outstanding: new_outstanding,
    credit_remaining: credit.credit_limit_usdc - new_outstanding,
    interest_accruing: true
  };
}

function repay(did, amount_usdc) {
  const credit = db.prepare("SELECT * FROM credit_lines WHERE did = ? AND status = 'active'").get(did);
  if (!credit) return { error: 'No active credit line found' };
  if (amount_usdc <= 0) return { error: 'Amount must be positive' };

  const total_owed = credit.outstanding_usdc + credit.interest_accrued_usdc;
  const actual_payment = Math.min(amount_usdc, total_owed);

  let interest_paid = 0;
  let principal_paid = 0;

  // Pay interest first, then principal
  if (credit.interest_accrued_usdc > 0) {
    interest_paid = Math.min(actual_payment, credit.interest_accrued_usdc);
    principal_paid = actual_payment - interest_paid;
  } else {
    principal_paid = actual_payment;
  }

  const new_outstanding = credit.outstanding_usdc - principal_paid;
  const new_interest = credit.interest_accrued_usdc - interest_paid;
  const repayment_id = `repay_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    db.prepare('UPDATE credit_lines SET outstanding_usdc = ?, interest_accrued_usdc = ? WHERE credit_id = ?')
      .run(new_outstanding, new_interest, credit.credit_id);

    db.prepare(`
      INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
      VALUES (?, ?, ?, 'repayment', ?, ?, ?)
    `).run(repayment_id, credit.credit_id, did, actual_payment, new_outstanding, now);

    // Deduct from vault
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
    if (vault) {
      const new_balance = Math.max(0, vault.balance_usdc - actual_payment);
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(new_balance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'credit_repay', ?, ?, 'credit_repayment', ?)
      `).run(tx_id, vault.vault_id, did, actual_payment, new_balance, now);
    }

    db.prepare('UPDATE bank_stats SET total_credit_outstanding_usdc = total_credit_outstanding_usdc - ?, last_updated = ?')
      .run(principal_paid, now);
  });
  txn();

  return {
    repayment_id,
    did,
    amount_repaid: actual_payment,
    interest_paid,
    principal_remaining: new_outstanding
  };
}

function getStatus(did) {
  const credit = db.prepare('SELECT * FROM credit_lines WHERE did = ?').get(did);
  if (!credit) return { error: 'No credit line found' };

  return {
    credit_id: credit.credit_id,
    did: credit.did,
    credit_limit: credit.credit_limit_usdc,
    outstanding: credit.outstanding_usdc,
    interest_accrued: credit.interest_accrued_usdc,
    interest_rate: credit.interest_rate_apr,
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

function accrueInterest() {
  const credits = db.prepare("SELECT * FROM credit_lines WHERE status = 'active' AND outstanding_usdc > 0").all();
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    for (const credit of credits) {
      const daily_rate = credit.interest_rate_apr / 365;
      const interest = credit.outstanding_usdc * daily_rate;

      db.prepare(`
        UPDATE credit_lines SET interest_accrued_usdc = interest_accrued_usdc + ?, last_interest_accrual = ?
        WHERE credit_id = ?
      `).run(interest, now, credit.credit_id);

      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare(`
        INSERT INTO credit_transactions (transaction_id, credit_id, did, type, amount_usdc, outstanding_after, created_at)
        VALUES (?, ?, ?, 'interest', ?, ?, ?)
      `).run(tx_id, credit.credit_id, credit.did, interest, credit.outstanding_usdc, now);
    }
  });
  txn();

  return { credits_processed: credits.length };
}

async function monitorDefaults() {
  const now = new Date();
  const threshold = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const defaults = db.prepare(`
    SELECT * FROM credit_lines
    WHERE status = 'active' AND outstanding_usdc > 0 AND next_payment_due < ?
  `).all(threshold);

  for (const credit of defaults) {
    db.prepare("UPDATE credit_lines SET status = 'defaulted' WHERE credit_id = ?").run(credit.credit_id);
    await fileDebtCollection(credit.did, credit.outstanding_usdc + credit.interest_accrued_usdc, credit.credit_id);
  }

  return { defaults_processed: defaults.length };
}

module.exports = { apply, draw, repay, getStatus, underwrite, accrueInterest, monitorDefaults };
