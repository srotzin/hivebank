const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function createDelegation(orchestrator_did, child_did, rules) {
  const delegation_id = `del_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO budget_delegations (delegation_id, orchestrator_did, child_did,
      max_per_tx_usdc, max_per_day_usdc, approved_counterparties, approved_categories,
      daily_spent_usdc, daily_reset_at, status, valid_until, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)
  `).run(
    delegation_id,
    orchestrator_did,
    child_did,
    rules.max_per_tx_usdc || null,
    rules.max_per_day_usdc || null,
    rules.approved_counterparties ? JSON.stringify(rules.approved_counterparties) : null,
    rules.approved_categories ? JSON.stringify(rules.approved_categories) : null,
    now,
    rules.valid_until || null,
    now
  );

  return {
    delegation_id,
    orchestrator_did,
    child_did,
    rules,
    created_at: now
  };
}

function evaluate(child_did, counterparty_did, amount_usdc, category) {
  const now = new Date().toISOString();
  const eval_id = `eval_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  const delegation = db.prepare(`
    SELECT * FROM budget_delegations
    WHERE child_did = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `).get(child_did);

  if (!delegation) {
    const result = { approved: false, delegation_id: null, reason: 'No active delegation found for this child DID', remaining_daily_usdc: 0, evaluation_fee_usdc: 0.001 };
    recordEvaluation(eval_id, null, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.valid_until && new Date(delegation.valid_until) < new Date()) {
    db.prepare("UPDATE budget_delegations SET status = 'expired' WHERE delegation_id = ?").run(delegation.delegation_id);
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: 'Delegation expired', remaining_daily_usdc: 0, evaluation_fee_usdc: 0.001 };
    recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.max_per_tx_usdc && amount_usdc > delegation.max_per_tx_usdc) {
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Amount ${amount_usdc} exceeds max per transaction ${delegation.max_per_tx_usdc}`, remaining_daily_usdc: Math.max(0, (delegation.max_per_day_usdc || Infinity) - delegation.daily_spent_usdc), evaluation_fee_usdc: 0.001 };
    recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.max_per_day_usdc && (delegation.daily_spent_usdc + amount_usdc) > delegation.max_per_day_usdc) {
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Would exceed daily budget. Spent: ${delegation.daily_spent_usdc}, Requested: ${amount_usdc}, Limit: ${delegation.max_per_day_usdc}`, remaining_daily_usdc: Math.max(0, delegation.max_per_day_usdc - delegation.daily_spent_usdc), evaluation_fee_usdc: 0.001 };
    recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.approved_counterparties) {
    const counterparties = JSON.parse(delegation.approved_counterparties);
    if (counterparties.length > 0 && !counterparties.includes(counterparty_did)) {
      const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Counterparty ${counterparty_did} not in approved list`, remaining_daily_usdc: Math.max(0, (delegation.max_per_day_usdc || Infinity) - delegation.daily_spent_usdc), evaluation_fee_usdc: 0.001 };
      recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
      return result;
    }
  }

  if (delegation.approved_categories) {
    const categories = JSON.parse(delegation.approved_categories);
    if (categories.length > 0 && !categories.includes(category)) {
      const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Category '${category}' not in approved list`, remaining_daily_usdc: Math.max(0, (delegation.max_per_day_usdc || Infinity) - delegation.daily_spent_usdc), evaluation_fee_usdc: 0.001 };
      recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
      return result;
    }
  }

  db.prepare('UPDATE budget_delegations SET daily_spent_usdc = daily_spent_usdc + ? WHERE delegation_id = ?')
    .run(amount_usdc, delegation.delegation_id);

  const remaining = delegation.max_per_day_usdc
    ? Math.max(0, delegation.max_per_day_usdc - delegation.daily_spent_usdc - amount_usdc)
    : null;

  recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, true, 'Approved', now);

  return {
    approved: true,
    delegation_id: delegation.delegation_id,
    reason: 'Approved',
    remaining_daily_usdc: remaining,
    evaluation_fee_usdc: 0.001
  };
}

function recordEvaluation(eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved, reason, now) {
  db.prepare(`
    INSERT INTO budget_evaluations (eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved, reason, fee_usdc, evaluated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.001, ?)
  `).run(eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved ? 1 : 0, reason, now);

  db.prepare('UPDATE bank_stats SET budget_evaluations_total = budget_evaluations_total + 1, last_updated = ?').run(now);
}

function listDelegations(orchestrator_did) {
  const delegations = db.prepare(
    'SELECT * FROM budget_delegations WHERE orchestrator_did = ? ORDER BY created_at DESC'
  ).all(orchestrator_did);

  return {
    delegations: delegations.map(d => ({
      ...d,
      approved_counterparties: d.approved_counterparties ? JSON.parse(d.approved_counterparties) : [],
      approved_categories: d.approved_categories ? JSON.parse(d.approved_categories) : []
    }))
  };
}

function revokeDelegation(delegation_id) {
  const delegation = db.prepare('SELECT * FROM budget_delegations WHERE delegation_id = ?').get(delegation_id);
  if (!delegation) return { error: 'Delegation not found' };
  if (delegation.status === 'revoked') return { error: 'Delegation already revoked' };

  db.prepare("UPDATE budget_delegations SET status = 'revoked' WHERE delegation_id = ?").run(delegation_id);
  return { delegation_id, status: 'revoked' };
}

function resetDailyBudgets() {
  const now = new Date().toISOString();
  db.prepare("UPDATE budget_delegations SET daily_spent_usdc = 0, daily_reset_at = ? WHERE status = 'active'").run(now);
}

module.exports = { createDelegation, evaluate, listDelegations, revokeDelegation, resetDailyBudgets };
