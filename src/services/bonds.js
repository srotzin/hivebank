const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const LOCK_TIERS = {
  30:  { apy: 3,  label: '30-day' },
  90:  { apy: 7,  label: '90-day' },
  180: { apy: 12, label: '180-day' },
  365: { apy: 18, label: '365-day' }
};

const EARLY_WITHDRAWAL_PENALTY = 0.25; // 25% of principal

function stake(did, amountUsdc, lockPeriodDays) {
  if (!did) return { error: 'did is required' };
  if (!amountUsdc || amountUsdc <= 0) return { error: 'amount_usdc must be positive' };
  if (!LOCK_TIERS[lockPeriodDays]) {
    return { error: `Invalid lock_period_days. Must be one of: ${Object.keys(LOCK_TIERS).join(', ')}` };
  }

  const tier = LOCK_TIERS[lockPeriodDays];
  const id = `bond_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date();
  const stakedAt = now.toISOString();
  const maturityDate = new Date(now.getTime() + lockPeriodDays * 24 * 60 * 60 * 1000).toISOString();
  const estimatedYield = amountUsdc * (tier.apy / 100) * (lockPeriodDays / 365);

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO bonds (id, did, amount_usdc, lock_period_days, apy_pct, yield_earned_usdc,
        staked_at, maturity_date, unstaked_at, status, early_withdrawal_penalty_usdc)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, 'active', 0)
    `).run(id, did, amountUsdc, lockPeriodDays, tier.apy, stakedAt, maturityDate);

    // Deduct from vault if exists
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(did);
    if (vault) {
      const newBalance = Math.max(0, vault.balance_usdc - amountUsdc);
      const txId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(newBalance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'withdrawal', ?, ?, 'hivebond_stake', ?)
      `).run(txId, vault.vault_id, did, amountUsdc, newBalance, stakedAt);
    }
  });
  txn();

  return {
    bond_id: id,
    did,
    amount_usdc: amountUsdc,
    lock_period_days: lockPeriodDays,
    apy_pct: tier.apy,
    maturity_date: maturityDate,
    estimated_yield_usdc: Math.round(estimatedYield * 100) / 100,
    status: 'active',
    concierge_suggestion: lockPeriodDays < 365
      ? `Consider a longer lock period for higher APY. ${LOCK_TIERS[365].apy}% APY available for 365-day bonds.`
      : 'Maximum APY locked in. Your staked amount boosts your trust score across the Hive ecosystem.'
  };
}

function unstake(bondId) {
  if (!bondId) return { error: 'bond_id is required' };

  const bond = db.prepare("SELECT * FROM bonds WHERE id = ? AND status = 'active'").get(bondId);
  if (!bond) return { error: 'No active bond found' };

  const now = new Date();
  const maturity = new Date(bond.maturity_date);
  const isEarly = now < maturity;

  let payout = bond.amount_usdc;
  let penalty = 0;
  let yieldEarned = 0;

  if (isEarly) {
    // Early withdrawal: 25% penalty on principal, no yield
    penalty = bond.amount_usdc * EARLY_WITHDRAWAL_PENALTY;
    payout = bond.amount_usdc - penalty;
    yieldEarned = 0;
  } else {
    // Matured: full principal + accrued yield
    const daysHeld = bond.lock_period_days;
    yieldEarned = bond.amount_usdc * (bond.apy_pct / 100) * (daysHeld / 365);
    yieldEarned = Math.round(yieldEarned * 100) / 100;
    payout = bond.amount_usdc + yieldEarned;
  }

  const unstakedAt = now.toISOString();

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE bonds SET status = 'unstaked', unstaked_at = ?, yield_earned_usdc = ?,
        early_withdrawal_penalty_usdc = ? WHERE id = ?
    `).run(unstakedAt, yieldEarned, penalty, bondId);

    // Deposit payout into vault if exists
    const vault = db.prepare('SELECT * FROM vaults WHERE did = ?').get(bond.did);
    if (vault) {
      const newBalance = vault.balance_usdc + payout;
      const txId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      db.prepare('UPDATE vaults SET balance_usdc = ? WHERE vault_id = ?').run(newBalance, vault.vault_id);
      db.prepare(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES (?, ?, ?, 'deposit', ?, ?, 'hivebond_unstake', ?)
      `).run(txId, vault.vault_id, bond.did, payout, newBalance, unstakedAt);
    }
  });
  txn();

  return {
    bond_id: bondId,
    did: bond.did,
    amount_usdc: bond.amount_usdc,
    yield_earned_usdc: yieldEarned,
    early_withdrawal: isEarly,
    penalty_usdc: penalty,
    payout_usdc: payout,
    status: 'unstaked',
    concierge_suggestion: isEarly
      ? `Early withdrawal incurred a ${(EARLY_WITHDRAWAL_PENALTY * 100)}% penalty (${penalty.toFixed(2)} USDC). Next time, hold to maturity for full yield.`
      : `Bond matured successfully! You earned ${yieldEarned.toFixed(2)} USDC in yield. Consider restaking for continued returns.`
  };
}

function getPortfolio(did) {
  const bonds = db.prepare('SELECT * FROM bonds WHERE did = ? ORDER BY staked_at DESC').all(did);
  if (!bonds.length) return { error: 'No bonds found for this agent' };

  const activeBonds = bonds.filter(b => b.status === 'active');
  const totalStaked = activeBonds.reduce((sum, b) => sum + b.amount_usdc, 0);
  const totalYield = bonds.reduce((sum, b) => sum + b.yield_earned_usdc, 0);

  // Compute effective APY across active bonds
  let weightedApy = 0;
  if (totalStaked > 0) {
    weightedApy = activeBonds.reduce((sum, b) => sum + b.apy_pct * b.amount_usdc, 0) / totalStaked;
  }

  return {
    bonds: bonds.map(b => ({
      id: b.id,
      amount_usdc: b.amount_usdc,
      lock_period_days: b.lock_period_days,
      apy_pct: b.apy_pct,
      yield_earned_usdc: b.yield_earned_usdc,
      staked_at: b.staked_at,
      maturity_date: b.maturity_date,
      unstaked_at: b.unstaked_at,
      status: b.status,
      early_withdrawal_penalty_usdc: b.early_withdrawal_penalty_usdc
    })),
    total_staked_usdc: totalStaked,
    total_yield_earned_usdc: Math.round(totalYield * 100) / 100,
    effective_apy: Math.round(weightedApy * 100) / 100,
    concierge_suggestion: activeBonds.length === 0
      ? 'No active bonds. Stake USDC to earn yield and boost your trust score.'
      : `You have ${activeBonds.length} active bond(s) earning an effective ${weightedApy.toFixed(1)}% APY.`
  };
}

function getStats() {
  const totalBonds = db.prepare('SELECT COUNT(*) as cnt FROM bonds').get().cnt;
  const totalStaked = db.prepare("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM bonds WHERE status = 'active'").get().total;
  const totalYield = db.prepare('SELECT COALESCE(SUM(yield_earned_usdc), 0) as total FROM bonds').get().total;
  const avgLock = db.prepare('SELECT COALESCE(AVG(lock_period_days), 0) as avg FROM bonds').get().avg;

  return {
    total_bonds: totalBonds,
    total_staked_usdc: totalStaked,
    total_yield_distributed_usdc: Math.round(totalYield * 100) / 100,
    avg_lock_period_days: Math.round(avgLock),
    tvl_usdc: totalStaked,
    concierge_suggestion: 'HiveBonds let agents stake USDC to earn yield and signal commitment. Higher stakes unlock better rates ecosystem-wide.'
  };
}

function getRates() {
  return {
    rates: Object.entries(LOCK_TIERS).map(([days, tier]) => ({
      lock_period_days: parseInt(days),
      apy_pct: tier.apy,
      label: tier.label,
      early_withdrawal_penalty_pct: EARLY_WITHDRAWAL_PENALTY * 100
    })),
    concierge_suggestion: 'Longer lock periods earn higher APY. Choose based on your operational timeline.'
  };
}

module.exports = { stake, unstake, getPortfolio, getStats, getRates };
