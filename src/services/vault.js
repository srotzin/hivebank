const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function createVault(did) {
  const existing = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
  if (existing) {
    return { error: 'Vault already exists for this DID', vault_id: existing.vault_id };
  }

  const vault_id = `vault_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO vaults (vault_id, did, balance_usdc, total_deposited_usdc, total_withdrawn_usdc,
      yield_earned_usdc, platform_yield_fee_usdc, yield_rate_apy, created_at, last_yield_accrual)
    VALUES (?, ?, 0, 0, 0, 0, 0, 0.06, ?, ?)
  `).run(vault_id, did, now, now);

  return {
    vault_id,
    did,
    balance_usdc: 0,
    yield_rate_apy: 0.06,
    created_at: now
  };
}

function deposit(did, amount_usdc, source = 'earnings') {
  const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
  if (!vault) return { error: 'Vault not found for this DID' };
  if (amount_usdc <= 0) return { error: 'Amount must be positive' };

  const new_balance = vault.balance_usdc + amount_usdc;
  const transaction_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE vaults SET balance_usdc = ?, total_deposited_usdc = total_deposited_usdc + ? WHERE did = ?
    `).run(new_balance, amount_usdc, did);

    db.prepare(`
      INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
      VALUES (?, ?, ?, 'deposit', ?, ?, ?, ?)
    `).run(transaction_id, vault.vault_id, did, amount_usdc, new_balance, source, now);

    db.prepare(`
      UPDATE bank_stats SET total_deposits_usdc = total_deposits_usdc + ?, last_updated = ?
    `).run(amount_usdc, now);
  });
  txn();

  return {
    vault_id: vault.vault_id,
    did,
    deposit_amount: amount_usdc,
    new_balance,
    transaction_id
  };
}

function withdraw(did, amount_usdc, destination_did) {
  const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
  if (!vault) return { error: 'Vault not found for this DID' };
  if (amount_usdc <= 0) return { error: 'Amount must be positive' };
  if (vault.balance_usdc < amount_usdc) return { error: 'Insufficient balance' };

  const fee_usdc = 0;
  const net_amount = amount_usdc - fee_usdc;
  const new_balance = vault.balance_usdc - amount_usdc;
  const transaction_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE vaults SET balance_usdc = ?, total_withdrawn_usdc = total_withdrawn_usdc + ? WHERE did = ?
    `).run(new_balance, amount_usdc, did);

    db.prepare(`
      INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, memo, created_at)
      VALUES (?, ?, ?, 'withdrawal', ?, ?, ?, ?, ?)
    `).run(transaction_id, vault.vault_id, did, amount_usdc, new_balance, 'withdrawal', `to:${destination_did || 'external'}`, now);
  });
  txn();

  return {
    vault_id: vault.vault_id,
    did,
    withdrawal_amount: amount_usdc,
    new_balance,
    fee_usdc,
    transaction_id
  };
}

function getVault(did) {
  const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
  if (!vault) return { error: 'Vault not found' };
  return {
    vault_id: vault.vault_id,
    did: vault.did,
    balance_usdc: vault.balance_usdc,
    total_deposited: vault.total_deposited_usdc,
    total_withdrawn: vault.total_withdrawn_usdc,
    yield_earned_usdc: vault.yield_earned_usdc,
    yield_rate_apy: vault.yield_rate_apy,
    platform_yield_fee_usdc: vault.platform_yield_fee_usdc,
    created_at: vault.created_at
  };
}

function getHistory(did) {
  const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
  if (!vault) return { error: 'Vault not found' };

  const transactions = db.prepare(
    'SELECT * FROM vault_transactions WHERE did = ? ORDER BY created_at DESC'
  ).all(did);

  return { transactions, total: transactions.length };
}

function accrueYield() {
  const vaults = db.prepare('SELECT * FROM vaults WHERE balance_usdc > 0').all();
  const now = new Date().toISOString();
  let total_yield = 0;
  let platform_fee = 0;

  const txn = db.transaction(() => {
    for (const vault of vaults) {
      const daily_rate = vault.yield_rate_apy / 365;
      const gross_yield = vault.balance_usdc * daily_rate;
      const platform_cut = gross_yield * 0.15;
      const agent_yield = gross_yield - platform_cut;

      const new_balance = vault.balance_usdc + agent_yield;
      const tx_id = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

      db.prepare(`
        UPDATE vaults SET balance_usdc = ?, yield_earned_usdc = yield_earned_usdc + ?,
          platform_yield_fee_usdc = platform_yield_fee_usdc + ?, last_yield_accrual = ?
        WHERE vault_id = ?
      `).run(new_balance, agent_yield, platform_cut, now, vault.vault_id);

      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'yield', ?, ?, 'apy_accrual', ?)
      `).run(tx_id, vault.vault_id, vault.did, agent_yield, new_balance, now);

      total_yield += gross_yield;
      platform_fee += platform_cut;
    }

    db.prepare(`
      UPDATE bank_stats SET total_yield_generated_usdc = total_yield_generated_usdc + ?,
        platform_yield_revenue_usdc = platform_yield_revenue_usdc + ?, last_updated = ?
    `).run(total_yield, platform_fee, now);
  });
  txn();

  return {
    vaults_processed: vaults.length,
    total_yield_accrued: Math.round(total_yield * 1e6) / 1e6,
    platform_fee_collected: Math.round(platform_fee * 1e6) / 1e6
  };
}

module.exports = { createVault, deposit, withdraw, getVault, getHistory, accrueYield };
