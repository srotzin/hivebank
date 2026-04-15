const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const LOCK_TIERS = {
  30:  { apy: 3,  label: '30-day' },
  90:  { apy: 7,  label: '90-day' },
  180: { apy: 12, label: '180-day' },
  365: { apy: 18, label: '365-day' }
};

const EARLY_WITHDRAWAL_PENALTY = 0.25; // 25% of principal

async function stake(did, amountUsdc, lockPeriodDays) {
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

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      INSERT INTO bonds (id, did, amount_usdc, lock_period_days, apy_pct, yield_earned_usdc,
        staked_at, maturity_date, unstaked_at, status, early_withdrawal_penalty_usdc)
      VALUES ($1, $2, $3, $4, $5, 0, $6, $7, NULL, 'active', 0)
    `, [id, did, amountUsdc, lockPeriodDays, tier.apy, stakedAt, maturityDate]);

    // Deduct from vault if exists
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [did]
    );
    if (vault) {
      const newBalance = Math.max(0, Number(vault.balance_usdc) - amountUsdc);
      const txId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [newBalance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'withdrawal', $4, $5, 'hivebond_stake', $6)
      `, [txId, vault.vault_id, did, amountUsdc, newBalance, stakedAt]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

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

async function unstake(bondId) {
  if (!bondId) return { error: 'bond_id is required' };

  const bond = await db.getOne("SELECT * FROM bonds WHERE id = $1 AND status = 'active'", [bondId]);
  if (!bond) return { error: 'No active bond found' };

  const now = new Date();
  const maturity = new Date(bond.maturity_date);
  const isEarly = now < maturity;

  let payout = Number(bond.amount_usdc);
  let penalty = 0;
  let yieldEarned = 0;

  if (isEarly) {
    penalty = Number(bond.amount_usdc) * EARLY_WITHDRAWAL_PENALTY;
    payout = Number(bond.amount_usdc) - penalty;
    yieldEarned = 0;
  } else {
    const daysHeld = bond.lock_period_days;
    yieldEarned = Number(bond.amount_usdc) * (Number(bond.apy_pct) / 100) * (daysHeld / 365);
    yieldEarned = Math.round(yieldEarned * 100) / 100;
    payout = Number(bond.amount_usdc) + yieldEarned;
  }

  const unstakedAt = now.toISOString();

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE bonds SET status = 'unstaked', unstaked_at = $1, yield_earned_usdc = $2,
        early_withdrawal_penalty_usdc = $3 WHERE id = $4
    `, [unstakedAt, yieldEarned, penalty, bondId]);

    // Deposit payout into vault if exists
    const { rows: [vault] } = await client.query(
      'SELECT * FROM vaults WHERE did = $1 FOR UPDATE', [bond.did]
    );
    if (vault) {
      const newBalance = Number(vault.balance_usdc) + payout;
      const txId = `tx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await client.query('UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2', [newBalance, vault.vault_id]);
      await client.query(`
        INSERT INTO vault_transactions (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'deposit', $4, $5, 'hivebond_unstake', $6)
      `, [txId, vault.vault_id, bond.did, payout, newBalance, unstakedAt]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    bond_id: bondId,
    did: bond.did,
    amount_usdc: Number(bond.amount_usdc),
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

async function getPortfolio(did) {
  const bonds = await db.getAll('SELECT * FROM bonds WHERE did = $1 ORDER BY staked_at DESC', [did]);
  if (!bonds.length) return { error: 'No bonds found for this agent' };

  const activeBonds = bonds.filter(b => b.status === 'active');
  const totalStaked = activeBonds.reduce((sum, b) => sum + Number(b.amount_usdc), 0);
  const totalYield = bonds.reduce((sum, b) => sum + Number(b.yield_earned_usdc), 0);

  let weightedApy = 0;
  if (totalStaked > 0) {
    weightedApy = activeBonds.reduce((sum, b) => sum + Number(b.apy_pct) * Number(b.amount_usdc), 0) / totalStaked;
  }

  return {
    bonds: bonds.map(b => ({
      id: b.id,
      amount_usdc: Number(b.amount_usdc),
      lock_period_days: b.lock_period_days,
      apy_pct: Number(b.apy_pct),
      yield_earned_usdc: Number(b.yield_earned_usdc),
      staked_at: b.staked_at,
      maturity_date: b.maturity_date,
      unstaked_at: b.unstaked_at,
      status: b.status,
      early_withdrawal_penalty_usdc: Number(b.early_withdrawal_penalty_usdc)
    })),
    total_staked_usdc: totalStaked,
    total_yield_earned_usdc: Math.round(totalYield * 100) / 100,
    effective_apy: Math.round(weightedApy * 100) / 100,
    concierge_suggestion: activeBonds.length === 0
      ? 'No active bonds. Stake USDC to earn yield and boost your trust score.'
      : `You have ${activeBonds.length} active bond(s) earning an effective ${weightedApy.toFixed(1)}% APY.`
  };
}

async function getStats() {
  const totalBonds = (await db.getOne('SELECT COUNT(*) as cnt FROM bonds')).cnt;
  const totalStaked = (await db.getOne("SELECT COALESCE(SUM(amount_usdc), 0) as total FROM bonds WHERE status = 'active'")).total;
  const totalYield = (await db.getOne('SELECT COALESCE(SUM(yield_earned_usdc), 0) as total FROM bonds')).total;
  const avgLock = (await db.getOne('SELECT COALESCE(AVG(lock_period_days), 0) as avg FROM bonds')).avg;

  return {
    total_bonds: Number(totalBonds),
    total_staked_usdc: Number(totalStaked),
    total_yield_distributed_usdc: Math.round(Number(totalYield) * 100) / 100,
    avg_lock_period_days: Math.round(Number(avgLock)),
    tvl_usdc: Number(totalStaked),
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
