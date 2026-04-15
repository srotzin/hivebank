const { v4: uuidv4 } = require('uuid');
const db = require('./db');

async function createDelegation(orchestrator_did, child_did, rules) {
  const delegation_id = `del_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  await db.run(`
    INSERT INTO budget_delegations (delegation_id, orchestrator_did, child_did,
      max_per_tx_usdc, max_per_day_usdc, approved_counterparties, approved_categories,
      daily_spent_usdc, daily_reset_at, status, valid_until, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, 'active', $9, $10)
  `, [
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
  ]);

  return {
    delegation_id,
    orchestrator_did,
    child_did,
    rules,
    created_at: now
  };
}

async function evaluate(child_did, counterparty_did, amount_usdc, category) {
  const now = new Date().toISOString();
  const eval_id = `eval_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  const delegation = await db.getOne(`
    SELECT * FROM budget_delegations
    WHERE child_did = $1 AND status = 'active'
    ORDER BY created_at DESC LIMIT 1
  `, [child_did]);

  if (!delegation) {
    const result = { approved: false, delegation_id: null, reason: 'No active delegation found for this child DID', remaining_daily_usdc: 0, evaluation_fee_usdc: 0.001 };
    await recordEvaluation(eval_id, null, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.valid_until && new Date(delegation.valid_until) < new Date()) {
    await db.run("UPDATE budget_delegations SET status = 'expired' WHERE delegation_id = $1", [delegation.delegation_id]);
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: 'Delegation expired', remaining_daily_usdc: 0, evaluation_fee_usdc: 0.001 };
    await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.max_per_tx_usdc && amount_usdc > Number(delegation.max_per_tx_usdc)) {
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Amount ${amount_usdc} exceeds max per transaction ${delegation.max_per_tx_usdc}`, remaining_daily_usdc: Math.max(0, (Number(delegation.max_per_day_usdc) || Infinity) - Number(delegation.daily_spent_usdc)), evaluation_fee_usdc: 0.001 };
    await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.max_per_day_usdc && (Number(delegation.daily_spent_usdc) + amount_usdc) > Number(delegation.max_per_day_usdc)) {
    const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Would exceed daily budget. Spent: ${delegation.daily_spent_usdc}, Requested: ${amount_usdc}, Limit: ${delegation.max_per_day_usdc}`, remaining_daily_usdc: Math.max(0, Number(delegation.max_per_day_usdc) - Number(delegation.daily_spent_usdc)), evaluation_fee_usdc: 0.001 };
    await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
    return result;
  }

  if (delegation.approved_counterparties) {
    const counterparties = JSON.parse(delegation.approved_counterparties);
    if (counterparties.length > 0 && !counterparties.includes(counterparty_did)) {
      const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Counterparty ${counterparty_did} not in approved list`, remaining_daily_usdc: Math.max(0, (Number(delegation.max_per_day_usdc) || Infinity) - Number(delegation.daily_spent_usdc)), evaluation_fee_usdc: 0.001 };
      await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
      return result;
    }
  }

  if (delegation.approved_categories) {
    const categories = JSON.parse(delegation.approved_categories);
    if (categories.length > 0 && !categories.includes(category)) {
      const result = { approved: false, delegation_id: delegation.delegation_id, reason: `Category '${category}' not in approved list`, remaining_daily_usdc: Math.max(0, (Number(delegation.max_per_day_usdc) || Infinity) - Number(delegation.daily_spent_usdc)), evaluation_fee_usdc: 0.001 };
      await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, false, result.reason, now);
      return result;
    }
  }

  await db.run('UPDATE budget_delegations SET daily_spent_usdc = daily_spent_usdc + $1 WHERE delegation_id = $2',
    [amount_usdc, delegation.delegation_id]);

  const remaining = delegation.max_per_day_usdc
    ? Math.max(0, Number(delegation.max_per_day_usdc) - Number(delegation.daily_spent_usdc) - amount_usdc)
    : null;

  await recordEvaluation(eval_id, delegation.delegation_id, child_did, counterparty_did, amount_usdc, category, true, 'Approved', now);

  return {
    approved: true,
    delegation_id: delegation.delegation_id,
    reason: 'Approved',
    remaining_daily_usdc: remaining,
    evaluation_fee_usdc: 0.001
  };
}

async function recordEvaluation(eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved, reason, now) {
  await db.run(`
    INSERT INTO budget_evaluations (eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved, reason, fee_usdc, evaluated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0.001, $9)
  `, [eval_id, delegation_id, child_did, counterparty_did, amount_usdc, category, approved ? 1 : 0, reason, now]);

  await db.run('UPDATE bank_stats SET budget_evaluations_total = budget_evaluations_total + 1, last_updated = $1', [now]);
}

async function listDelegations(orchestrator_did) {
  const delegations = await db.getAll(
    'SELECT * FROM budget_delegations WHERE orchestrator_did = $1 ORDER BY created_at DESC', [orchestrator_did]
  );

  return {
    delegations: delegations.map(d => ({
      ...d,
      approved_counterparties: d.approved_counterparties ? JSON.parse(d.approved_counterparties) : [],
      approved_categories: d.approved_categories ? JSON.parse(d.approved_categories) : []
    }))
  };
}

async function revokeDelegation(delegation_id) {
  const delegation = await db.getOne('SELECT * FROM budget_delegations WHERE delegation_id = $1', [delegation_id]);
  if (!delegation) return { error: 'Delegation not found' };
  if (delegation.status === 'revoked') return { error: 'Delegation already revoked' };

  await db.run("UPDATE budget_delegations SET status = 'revoked' WHERE delegation_id = $1", [delegation_id]);
  return { delegation_id, status: 'revoked' };
}

async function resetDailyBudgets() {
  const now = new Date().toISOString();
  await db.run("UPDATE budget_delegations SET daily_spent_usdc = 0, daily_reset_at = $1 WHERE status = 'active'", [now]);
}

module.exports = { createDelegation, evaluate, listDelegations, revokeDelegation, resetDailyBudgets };
