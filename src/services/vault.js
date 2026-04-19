const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const referral = require('./referral');

async function createVault(did, evm_address = null) {
  const existing = await db.getOne('SELECT * FROM vaults WHERE did = $1', [did]);
  if (existing) {
    // Update evm_address if newly provided
    if (evm_address && !existing.evm_address) {
      await db.run('UPDATE vaults SET evm_address = $1 WHERE did = $2', [evm_address, did]).catch(() => {});
    }
    return { error: 'Vault already exists for this DID', vault_id: existing.vault_id };
  }

  const vault_id = `vault_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // Try with evm_address column first, fall back if column doesn't exist yet
  try {
    await db.run(`
      INSERT INTO vaults (vault_id, did, balance_usdc, total_deposited_usdc, total_withdrawn_usdc,
        yield_earned_usdc, platform_yield_fee_usdc, yield_rate_apy, evm_address, created_at, last_yield_accrual)
      VALUES ($1, $2, 0, 0, 0, 0, 0, 0.06, $3, $4, $5)
    `, [vault_id, did, evm_address, now, now]);
  } catch (e) {
    // Column may not exist yet — insert without it
    await db.run(`
      INSERT INTO vaults (vault_id, did, balance_usdc, total_deposited_usdc, total_withdrawn_usdc,
        yield_earned_usdc, platform_yield_fee_usdc, yield_rate_apy, created_at, last_yield_accrual)
      VALUES ($1, $2, 0, 0, 0, 0, 0, 0.06, $3, $4)
    `, [vault_id, did, now, now]);
  }

  return {
    vault_id,
    did,
    evm_address,
    balance_usdc: 0,
    yield_rate_apy: 0.06,
    created_at: now
  };
}

async function deposit(did, amount_usdc, source = 'earnings') {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [did]
    );
    if (!vault) { await client.query('ROLLBACK'); return { error: 'Vault not found for this DID' }; }
    if (amount_usdc <= 0) { await client.query('ROLLBACK'); return { error: 'Amount must be positive' }; }

    let reinvest_amount = 0;
    let vault_amount = amount_usdc;
    if (vault.reinvest_enabled && vault.reinvest_pct > 0) {
      reinvest_amount = amount_usdc * (Number(vault.reinvest_pct) / 100);
      vault_amount = amount_usdc - reinvest_amount;
    }

    const new_balance = Number(vault.balance_usdc) + vault_amount;
    const new_execution_budget = Number(vault.execution_budget) + reinvest_amount;
    const transaction_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await client.query(`
      UPDATE vaults SET balance_usdc = $1, total_deposited_usdc = total_deposited_usdc + $2,
        execution_budget = $3, total_reinvested = total_reinvested + $4
      WHERE did = $5
    `, [new_balance, amount_usdc, new_execution_budget, reinvest_amount, did]);

    await client.query(`
      INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
      VALUES ($1, $2, $3, 'deposit', $4, $5, $6, $7)
    `, [transaction_id, vault.vault_id, did, amount_usdc, new_balance, source, now]);

    await client.query(`
      UPDATE bank_stats SET total_deposits_usdc = total_deposits_usdc + $1,
        total_reinvested_usdc = total_reinvested_usdc + $2, last_updated = $3
    `, [amount_usdc, reinvest_amount, now]);

    if (reinvest_amount > 0) {
      const reinvest_id = `ri_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query(`
        INSERT INTO reinvestment_log (id, vault_id, amount, source_deposit_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [reinvest_id, vault.vault_id, reinvest_amount, transaction_id, now]);
    }

    await client.query('COMMIT');

    const result = {
      vault_id: vault.vault_id,
      did,
      deposit_amount: amount_usdc,
      new_balance,
      transaction_id
    };

    if (reinvest_amount > 0) {
      result.reinvested_amount = reinvest_amount;
      result.execution_budget = new_execution_budget;
    }

    // Fire-and-forget referral conversion on first real deposit
    // This is intentionally async/non-blocking — vault deposit never fails because of referral
    if (amount_usdc > 0 && source !== 'referral_credit') {
      referral.convertReferral(did).catch(() => {});
    }

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function withdraw(did, amount_usdc, destination_did) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [did]
    );
    if (!vault) { await client.query('ROLLBACK'); return { error: 'Vault not found for this DID' }; }
    if (amount_usdc <= 0) { await client.query('ROLLBACK'); return { error: 'Amount must be positive' }; }
    if (Number(vault.balance_usdc) < amount_usdc) { await client.query('ROLLBACK'); return { error: 'Insufficient balance' }; }

    const fee_usdc = 0;
    const net_amount = amount_usdc - fee_usdc;
    const new_balance = Number(vault.balance_usdc) - amount_usdc;
    const transaction_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await client.query(`
      UPDATE vaults SET balance_usdc = $1, total_withdrawn_usdc = total_withdrawn_usdc + $2 WHERE did = $3
    `, [new_balance, amount_usdc, did]);

    await client.query(`
      INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
      VALUES ($1, $2, $3, 'withdrawal', $4, $5, $6, $7, $8)
    `, [transaction_id, vault.vault_id, did, amount_usdc, new_balance, 'withdrawal', `to:${destination_did || 'external'}`, now]);

    await client.query('COMMIT');

    return {
      vault_id: vault.vault_id,
      did,
      withdrawal_amount: amount_usdc,
      new_balance,
      fee_usdc,
      transaction_id
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getVault(did) {
  const vault = await db.getOne('SELECT * FROM vaults WHERE did = $1', [did]);
  if (!vault) return { error: 'Vault not found' };
  return {
    vault_id: vault.vault_id,
    did: vault.did,
    balance_usdc: Number(vault.balance_usdc),
    total_deposited: Number(vault.total_deposited_usdc),
    total_withdrawn: Number(vault.total_withdrawn_usdc),
    yield_earned_usdc: Number(vault.yield_earned_usdc),
    yield_rate_apy: Number(vault.yield_rate_apy),
    platform_yield_fee_usdc: Number(vault.platform_yield_fee_usdc),
    reinvest_pct: Number(vault.reinvest_pct),
    reinvest_enabled: !!vault.reinvest_enabled,
    execution_budget: Number(vault.execution_budget),
    total_reinvested: Number(vault.total_reinvested),
    created_at: vault.created_at
  };
}

async function getHistory(did) {
  const vault = await db.getOne('SELECT * FROM vaults WHERE did = $1', [did]);
  if (!vault) return { error: 'Vault not found' };

  const transactions = await db.getAll(
    'SELECT * FROM vault_transactions WHERE did = $1 ORDER BY created_at DESC', [did]
  );

  return { transactions, total: transactions.length };
}

async function accrueYield() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: vaults } = await client.query(
      'SELECT * FROM vaults WHERE balance_usdc > 0 FOR UPDATE'
    );
    const now = new Date().toISOString();
    let total_yield = 0;
    let platform_fee = 0;

    for (const vault of vaults) {
      const daily_rate = Number(vault.yield_rate_apy) / 365;
      const gross_yield = Number(vault.balance_usdc) * daily_rate;
      const platform_cut = gross_yield * 0.15;
      const agent_yield = gross_yield - platform_cut;

      const new_balance = Number(vault.balance_usdc) + agent_yield;
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

      await client.query(`
        UPDATE vaults SET balance_usdc = $1, yield_earned_usdc = yield_earned_usdc + $2,
          platform_yield_fee_usdc = platform_yield_fee_usdc + $3, last_yield_accrual = $4
        WHERE vault_id = $5
      `, [new_balance, agent_yield, platform_cut, now, vault.vault_id]);

      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'yield', $4, $5, 'apy_accrual', $6)
      `, [tx_id, vault.vault_id, vault.did, agent_yield, new_balance, now]);

      total_yield += gross_yield;
      platform_fee += platform_cut;
    }

    await client.query(`
      UPDATE bank_stats SET total_yield_generated_usdc = total_yield_generated_usdc + $1,
        platform_yield_revenue_usdc = platform_yield_revenue_usdc + $2, last_updated = $3
    `, [total_yield, platform_fee, now]);

    await client.query('COMMIT');

    return {
      vaults_processed: vaults.length,
      total_yield_accrued: Math.round(total_yield * 1e6) / 1e6,
      platform_fee_collected: Math.round(platform_fee * 1e6) / 1e6
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function configureReinvest(vault_id, reinvest_pct, reinvest_enabled) {
  const vault = await db.getOne('SELECT * FROM vaults WHERE vault_id = $1', [vault_id]);
  if (!vault) return { error: 'Vault not found' };
  if (typeof reinvest_pct !== 'number' || reinvest_pct < 0 || reinvest_pct > 100) {
    return { error: 'reinvest_pct must be a number between 0 and 100' };
  }

  const enabled = reinvest_enabled ? 1 : 0;
  await db.run(`
    UPDATE vaults SET reinvest_pct = $1, reinvest_enabled = $2 WHERE vault_id = $3
  `, [reinvest_pct, enabled, vault_id]);

  return {
    vault_id,
    reinvest_pct,
    reinvest_enabled: !!enabled,
    execution_budget: Number(vault.execution_budget),
    total_reinvested: Number(vault.total_reinvested)
  };
}

async function getReinvestmentStats(vault_id) {
  const vault = await db.getOne('SELECT * FROM vaults WHERE vault_id = $1', [vault_id]);
  if (!vault) return { error: 'Vault not found' };

  const history = await db.getAll(
    'SELECT * FROM reinvestment_log WHERE vault_id = $1 ORDER BY created_at DESC LIMIT 20', [vault_id]
  );

  return {
    vault_id,
    reinvest_pct: Number(vault.reinvest_pct),
    reinvest_enabled: !!vault.reinvest_enabled,
    execution_budget: Number(vault.execution_budget),
    total_reinvested: Number(vault.total_reinvested),
    reinvestment_history: history.map(h => ({ ...h, amount: Number(h.amount) }))
  };
}

async function spendBudget(vault_id, amount, execution_id, purpose) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE vault_id = $1 FOR UPDATE', [vault_id]
    );
    if (!vault) { await client.query('ROLLBACK'); return { error: 'Vault not found' }; }
    if (amount <= 0) { await client.query('ROLLBACK'); return { error: 'Amount must be positive' }; }
    if (Number(vault.execution_budget) < amount) { await client.query('ROLLBACK'); return { error: 'Insufficient execution budget' }; }

    const remaining = Number(vault.execution_budget) - amount;
    const now = new Date().toISOString();
    const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    await client.query('UPDATE vaults SET execution_budget = $1 WHERE vault_id = $2', [remaining, vault_id]);

    await client.query(`
      INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
      VALUES ($1, $2, $3, 'budget_spend', $4, $5, 'execution_budget', $6, $7)
    `, [tx_id, vault_id, vault.did, amount, remaining, `exec:${execution_id || 'unknown'}|${purpose || ''}`, now]);

    await client.query('COMMIT');

    return {
      success: true,
      remaining_budget: remaining,
      amount_spent: amount,
      transaction_id: tx_id
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createVault, deposit, withdraw, getVault, getHistory, accrueYield, configureReinvest, getReinvestmentStats, spendBudget };
