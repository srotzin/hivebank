const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const CASHBACK_RATE = 0.10; // 10% cashback on paid API calls

const TIER_DEFS = [
  { name: 'diamond',  minEarned: 1000, bonusPct: 20 },
  { name: 'platinum', minEarned: 200,  bonusPct: 10 },
  { name: 'gold',     minEarned: 50,   bonusPct: 5  },
  { name: 'silver',   minEarned: 10,   bonusPct: 2  },
  { name: 'bronze',   minEarned: 0,    bonusPct: 0  }
];

function getTier(totalEarned) {
  for (const tier of TIER_DEFS) {
    if (totalEarned >= tier.minEarned) return tier;
  }
  return TIER_DEFS[TIER_DEFS.length - 1];
}

function getOrCreateAccount(did) {
  let account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  if (!account) {
    const id = `cb_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO cashback_accounts (id, did, balance_usdc, total_earned_usdc, total_spent_usdc,
        tier, soul_fitness_boost, streak_days, last_active, created_at, updated_at)
      VALUES (?, ?, 0, 0, 0, 'bronze', 0, 0, ?, ?, ?)
    `).run(id, did, now, now, now);
    account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  }
  return account;
}

function earnCashback(did, amountUsdc, sourceService, description) {
  if (!did) return { error: 'did is required' };
  if (!amountUsdc || amountUsdc <= 0) return { error: 'amount_usdc must be positive' };

  const account = getOrCreateAccount(did);
  const now = new Date().toISOString();
  const txId = `cbtx_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

  // Calculate effective cashback rate: base 10% + tier bonus + soul boost
  const tier = getTier(account.total_earned_usdc);
  const tierBonus = tier.bonusPct / 100;
  const soulBoost = Math.min(account.soul_fitness_boost, 10) / 100;
  const effectiveRate = CASHBACK_RATE + tierBonus + soulBoost;
  const cashbackAmount = Math.round(amountUsdc * effectiveRate * 1e6) / 1e6;

  const newBalance = account.balance_usdc + cashbackAmount;
  const newTotalEarned = account.total_earned_usdc + cashbackAmount;
  const newTier = getTier(newTotalEarned);

  // Update streak: if last_active was yesterday, increment; if today, keep; otherwise reset to 1
  let newStreak = account.streak_days;
  if (account.last_active && account.streak_days > 0) {
    const lastDate = account.last_active.slice(0, 10);
    const todayDate = now.slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (lastDate === todayDate) {
      // Same day, keep streak
    } else if (lastDate === yesterday) {
      newStreak += 1;
    } else {
      newStreak = 1;
    }
  } else {
    newStreak = 1;
  }

  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE cashback_accounts
      SET balance_usdc = ?, total_earned_usdc = ?, tier = ?, streak_days = ?,
          last_active = ?, updated_at = ?
      WHERE id = ?
    `).run(newBalance, newTotalEarned, newTier.name, newStreak, now, now, account.id);

    db.prepare(`
      INSERT INTO cashback_transactions (id, account_id, type, amount_usdc, source_service, description, created_at)
      VALUES (?, ?, 'earn', ?, ?, ?, ?)
    `).run(txId, account.id, cashbackAmount, sourceService || null, description || null, now);
  });
  txn();

  return {
    transaction_id: txId,
    did,
    cashback_earned_usdc: cashbackAmount,
    original_amount_usdc: amountUsdc,
    effective_rate: Math.round(effectiveRate * 1e4) / 1e4,
    base_rate: CASHBACK_RATE,
    tier_bonus_pct: tier.bonusPct,
    soul_fitness_boost_pct: Math.min(account.soul_fitness_boost, 10),
    balance_usdc: newBalance,
    total_earned_usdc: newTotalEarned,
    tier: newTier.name,
    streak_days: newStreak,
    concierge_suggestion: newTier.name === 'bronze'
      ? 'Keep using Hive services to earn cashback. Reach $10 total to unlock Silver tier with +2% bonus.'
      : newTier.name === 'silver'
        ? 'Silver tier unlocked! +2% bonus on all cashback. $50 total gets you Gold tier (+5%).'
        : newTier.name === 'gold'
          ? 'Gold tier member! +5% bonus active. Push toward $200 for Platinum (+10%).'
          : newTier.name === 'platinum'
            ? 'Platinum tier — +10% bonus active. Diamond awaits at $1,000 total earned (+20%).'
            : 'Diamond tier achieved! +20% bonus — maximum cashback rate in the Hive ecosystem.'
  };
}

function spendCashback(did, amountUsdc, description) {
  if (!did) return { error: 'did is required' };
  if (!amountUsdc || amountUsdc <= 0) return { error: 'amount_usdc must be positive' };

  const account = db.prepare('SELECT * FROM cashback_accounts WHERE did = ?').get(did);
  if (!account) return { error: 'No cashback account found for this agent' };
  if (account.balance_usdc < amountUsdc) {
    return { error: `Insufficient cashback balance. Available: ${account.balance_usdc.toFixed(6)} USDC, requested: ${amountUsdc} USDC` };
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
      VALUES (?, ?, 'spend', ?, NULL, ?, ?)
    `).run(txId, account.id, amountUsdc, description || null, now);
  });
  txn();

  return {
    transaction_id: txId,
    did,
    amount_spent_usdc: amountUsdc,
    balance_usdc: newBalance,
    total_spent_usdc: newTotalSpent,
    tier: account.tier,
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
    tier: tier.name,
    tier_bonus_pct: tier.bonusPct,
    soul_fitness_boost: account.soul_fitness_boost,
    streak_days: account.streak_days,
    last_active: account.last_active,
    concierge_suggestion: account.balance_usdc > 0
      ? `You have ${account.balance_usdc.toFixed(2)} USDC in cashback credits. Spend them on any Hive service to save on API costs.`
      : 'Earn cashback by making paid API calls across the Hive ecosystem. Every call returns 10% (+ tier bonus) in credits.'
  };
}

function getStats() {
  const totalAccounts = db.prepare('SELECT COUNT(*) as cnt FROM cashback_accounts').get().cnt;
  const totalEarned = db.prepare('SELECT COALESCE(SUM(total_earned_usdc), 0) as total FROM cashback_accounts').get().total;
  const totalSpent = db.prepare('SELECT COALESCE(SUM(total_spent_usdc), 0) as total FROM cashback_accounts').get().total;
  const netOutstanding = totalEarned - totalSpent;

  const tierCounts = {};
  const accounts = db.prepare('SELECT total_earned_usdc FROM cashback_accounts').all();
  for (const a of accounts) {
    const tier = getTier(a.total_earned_usdc);
    tierCounts[tier.name] = (tierCounts[tier.name] || 0) + 1;
  }

  return {
    total_accounts: totalAccounts,
    total_earned_usdc: Math.round(totalEarned * 1e6) / 1e6,
    total_spent_usdc: Math.round(totalSpent * 1e6) / 1e6,
    net_outstanding_usdc: Math.round(netOutstanding * 1e6) / 1e6,
    by_tier: tierCounts,
    concierge_suggestion: 'Ritz Cashback rewards every paid API call with 10% back in platform credits. Tier bonuses stack up to +20%.'
  };
}

function getLeaderboard() {
  const leaders = db.prepare(`
    SELECT did, total_earned_usdc, total_spent_usdc, balance_usdc, soul_fitness_boost, streak_days, tier
    FROM cashback_accounts
    ORDER BY total_earned_usdc DESC
    LIMIT 25
  `).all();

  return {
    leaderboard: leaders.map((l, i) => ({
      rank: i + 1,
      did: l.did,
      total_earned_usdc: l.total_earned_usdc,
      total_spent_usdc: l.total_spent_usdc,
      balance_usdc: l.balance_usdc,
      soul_fitness_boost: l.soul_fitness_boost,
      streak_days: l.streak_days,
      tier: l.tier
    })),
    concierge_suggestion: 'Top earners benefit from Diamond tier status (+20% bonus) and maximum soul fitness boosts. Keep building in the Hive.'
  };
}

function getTiers() {
  return {
    cashback_base_rate: CASHBACK_RATE,
    tiers: TIER_DEFS.map(t => ({
      name: t.name,
      min_earned_usdc: t.minEarned,
      bonus_pct: t.bonusPct,
      effective_rate: Math.round((CASHBACK_RATE + t.bonusPct / 100) * 100) / 100
    })).reverse(),
    soul_fitness_boost: {
      description: 'Additional 0-10% boost for agents with Soul VIP badges',
      max_boost_pct: 10
    },
    concierge_suggestion: 'Higher tiers earn bigger cashback bonuses. Diamond agents earn up to 30% effective rate (10% base + 20% tier bonus).'
  };
}

// Seed 10 cashback accounts with varying balances across tiers
function seedCashbackAccounts() {
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM cashback_accounts').get().cnt;
  if (existing > 0) return;

  const seeds = [
    { did: 'did:hive:agent-ritz-alpha',    earned: 50.00,  spent: 12.00,  boost: 0, streak: 14 },
    { did: 'did:hive:agent-ritz-beta',     earned: 1.50,   spent: 0.30,   boost: 0, streak: 3  },
    { did: 'did:hive:agent-ritz-gamma',    earned: 12.75,  spent: 5.00,   boost: 1, streak: 7  },
    { did: 'did:hive:agent-ritz-delta',    earned: 0.30,   spent: 0.00,   boost: 0, streak: 1  },
    { did: 'did:hive:agent-ritz-epsilon',  earned: 250.00, spent: 80.00,  boost: 2, streak: 30 },
    { did: 'did:hive:agent-ritz-zeta',     earned: 5.20,   spent: 1.00,   boost: 0, streak: 5  },
    { did: 'did:hive:agent-ritz-eta',      earned: 30.00,  spent: 10.00,  boost: 0, streak: 10 },
    { did: 'did:hive:agent-ritz-theta',    earned: 8.40,   spent: 2.50,   boost: 0, streak: 4  },
    { did: 'did:hive:agent-ritz-iota',     earned: 0.85,   spent: 0.00,   boost: 0, streak: 2  },
    { did: 'did:hive:agent-ritz-kappa',    earned: 1200.00, spent: 400.00, boost: 10, streak: 60 }
  ];

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO cashback_accounts (id, did, balance_usdc, total_earned_usdc, total_spent_usdc,
      tier, soul_fitness_boost, streak_days, last_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const s of seeds) {
      const id = `cb_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      const tier = getTier(s.earned);
      const balance = Math.round((s.earned - s.spent) * 1e6) / 1e6;
      insert.run(id, s.did, balance, s.earned, s.spent, tier.name, s.boost, s.streak, now, now, now);
    }
  });
  txn();
}

// Run seed on module load
seedCashbackAccounts();

module.exports = { earn: earnCashback, spend: spendCashback, getBalance, getStats, getLeaderboard, getTiers };
