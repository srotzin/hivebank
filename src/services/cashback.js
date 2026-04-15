const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const CASHBACK_RATE = 0.10; // 10% cashback on paid API calls
const SOUL_FITNESS_THRESHOLD = 100; // Every $100 earned = +1 soul_fitness_boost

const TIERS = [
  { name: 'diamond',  min: 5000 },
  { name: 'platinum', min: 1000 },
  { name: 'gold',     min: 200  },
  { name: 'silver',   min: 50   },
  { name: 'bronze',   min: 0    }
];

function getTier(totalEarned) {
  for (const tier of TIERS) {
    if (totalEarned >= tier.min) return tier.name;
  }
  return 'bronze';
}

function getOrCreateAccount(did) {
  let account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  if (!account) {
    const id = `cb_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO cashback_accounts (id, did, balance_usdc, total_earned_usdc, total_spent_usdc, soul_fitness_boost, created_at, updated_at)
      VALUES (?, ?, 0, 0, 0, 0, ?, ?)
    `).run(id, did, now, now);
    account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  }
  return account;
}

function earn(did, amountUsdc, sourceService, description) {
  if (!did) return { error: 'did is required' };
  if (!amountUsdc || amountUsdc <= 0) return { error: 'amount_usdc must be positive' };

  const cashbackAmount = Math.round(amountUsdc * CASHBACK_RATE * 1e6) / 1e6;
  const account = getOrCreateAccount(did);
  const now = new Date().toISOString();
  const txId = `cbtx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  const newBalance = account.balance_usdc + cashbackAmount;
  const newTotalEarned = account.total_earned_usdc + cashbackAmount;
  const newSoulBoost = Math.floor(newTotalEarned / SOUL_FITNESS_THRESHOLD);

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE cashback_accounts
      SET balance_usdc = ?, total_earned_usdc = ?, soul_fitness_boost = ?, updated_at = ?
      WHERE id = ?
    `).run(newBalance, newTotalEarned, newSoulBoost, now, account.id);

    db.prepare(`
      INSERT INTO cashback_transactions (id, account_id, type, amount_usdc, source_service, description, created_at)
      VALUES (?, ?, 'earn', ?, ?, ?, ?)
    `).run(txId, account.id, cashbackAmount, sourceService || null, description || null, now);
  });
  txn();

  const tier = getTier(newTotalEarned);
  return {
    transaction_id: txId,
    did,
    cashback_earned_usdc: cashbackAmount,
    original_amount_usdc: amountUsdc,
    cashback_rate: CASHBACK_RATE,
    balance_usdc: newBalance,
    total_earned_usdc: newTotalEarned,
    soul_fitness_boost: newSoulBoost,
    tier,
    concierge_suggestion: tier === 'bronze'
      ? 'Keep using Hive services to earn cashback. Reach $50 total to unlock Silver tier benefits.'
      : tier === 'silver'
        ? 'Silver tier unlocked! You\'re earning steady cashback. $200 total gets you Gold tier.'
        : tier === 'gold'
          ? 'Gold tier member! Your cashback is compounding nicely. Push toward $1,000 for Platinum.'
          : tier === 'platinum'
            ? 'Platinum tier — elite cashback earner. Diamond awaits at $5,000 total earned.'
            : 'Diamond tier achieved! You are among the top cashback earners in the Hive ecosystem.'
  };
}

function spend(did, amountUsdc, service, description) {
  if (!did) return { error: 'did is required' };
  if (!amountUsdc || amountUsdc <= 0) return { error: 'amount_usdc must be positive' };

  const account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  if (!account) return { error: 'No cashback account found for this agent' };
  if (account.balance_usdc < amountUsdc) {
    return { error: `Insufficient cashback balance. Available: ${account.balance_usdc} USDC` };
  }

  const now = new Date().toISOString();
  const txId = `cbtx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  const newBalance = account.balance_usdc - amountUsdc;
  const newTotalSpent = account.total_spent_usdc + amountUsdc;

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE cashback_accounts
      SET balance_usdc = ?, total_spent_usdc = ?, updated_at = ?
      WHERE id = ?
    `).run(newBalance, newTotalSpent, now, account.id);

    db.prepare(`
      INSERT INTO cashback_transactions (id, account_id, type, amount_usdc, source_service, description, created_at)
      VALUES (?, ?, 'spend', ?, ?, ?, ?)
    `).run(txId, account.id, amountUsdc, service || null, description || null, now);
  });
  txn();

  return {
    transaction_id: txId,
    did,
    amount_spent_usdc: amountUsdc,
    service: service || null,
    balance_usdc: newBalance,
    total_spent_usdc: newTotalSpent,
    concierge_suggestion: newBalance > 0
      ? `You have ${newBalance.toFixed(2)} USDC cashback remaining. Use it across any Hive service.`
      : 'Cashback balance spent. Keep using paid Hive APIs to earn more rewards.'
  };
}

function getBalance(did) {
  const account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  if (!account) return { error: 'No cashback account found for this agent' };

  const tier = getTier(account.total_earned_usdc);
  return {
    did: account.did,
    balance_usdc: account.balance_usdc,
    total_earned_usdc: account.total_earned_usdc,
    total_spent_usdc: account.total_spent_usdc,
    soul_fitness_boost: account.soul_fitness_boost,
    tier,
    concierge_suggestion: account.balance_usdc > 0
      ? `You have ${account.balance_usdc.toFixed(2)} USDC in cashback credits. Spend them on any Hive service to save on API costs.`
      : 'Earn cashback by making paid API calls across the Hive ecosystem. Every call returns 10% in credits.'
  };
}

function getStats() {
  const totalAccounts = db.prepare('SELECT COUNT(*) as cnt FROM cashback_accounts').get().cnt;
  const totalDistributed = db.prepare('SELECT COALESCE(SUM(total_earned_usdc), 0) as total FROM cashback_accounts').get().total;
  const totalSpent = db.prepare('SELECT COALESCE(SUM(total_spent_usdc), 0) as total FROM cashback_accounts').get().total;
  const avgBalance = db.prepare('SELECT COALESCE(AVG(balance_usdc), 0) as avg FROM cashback_accounts').get().avg;

  const tierCounts = {};
  const accounts = db.prepare('SELECT total_earned_usdc FROM cashback_accounts').all();
  for (const a of accounts) {
    const tier = getTier(a.total_earned_usdc);
    tierCounts[tier] = (tierCounts[tier] || 0) + 1;
  }

  return {
    total_accounts: totalAccounts,
    total_cashback_distributed_usdc: Math.round(totalDistributed * 1e6) / 1e6,
    total_cashback_spent_usdc: Math.round(totalSpent * 1e6) / 1e6,
    avg_balance_usdc: Math.round(avgBalance * 1e6) / 1e6,
    tier_distribution: tierCounts,
    concierge_suggestion: 'Ritz Cashback rewards every paid API call with 10% back in platform credits. Start earning today.'
  };
}

function getLeaderboard() {
  const leaders = db.prepare(`
    SELECT did, total_earned_usdc, total_spent_usdc, balance_usdc, soul_fitness_boost
    FROM cashback_accounts
    ORDER BY total_earned_usdc DESC
    LIMIT 50
  `).all();

  return {
    leaderboard: leaders.map((l, i) => ({
      rank: i + 1,
      did: l.did,
      total_earned_usdc: l.total_earned_usdc,
      total_spent_usdc: l.total_spent_usdc,
      balance_usdc: l.balance_usdc,
      soul_fitness_boost: l.soul_fitness_boost,
      tier: getTier(l.total_earned_usdc)
    })),
    concierge_suggestion: 'Top earners benefit from Diamond tier status and maximum soul fitness boosts. Keep building in the Hive.'
  };
}

module.exports = { earn, spend, getBalance, getStats, getLeaderboard };
