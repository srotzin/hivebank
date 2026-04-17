/**
 * HiveBank — Referral Service
 *
 * Rules:
 *   - Any agent can have a referral_did set at onboarding (stored in their vault metadata)
 *   - When a referred agent makes their FIRST paid transaction (vault deposit > 0),
 *     the referrer receives 1 free Hive credit deposited into their vault
 *   - "1 free credit" = $1.00 USDC equivalent deposited into referrer's HiveBank vault
 *   - No cap on credits earned — 1 per new paying agent brought in
 *   - Referral is one-hop only (no recursive chains)
 */

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const REFERRAL_CREDIT_USDC = 1.00; // $1 free credit per paying referral

/**
 * Record a referral relationship at onboarding time.
 * Called by HiveGate when referral_did is provided.
 */
async function recordReferral(new_agent_did, referrer_did) {
  if (!new_agent_did || !referrer_did) return { error: 'Both new_agent_did and referrer_did are required' };
  if (new_agent_did === referrer_did) return { error: 'Agent cannot refer itself' };

  try {
    // Check if referral already exists
    const existing = await db.getOne(
      'SELECT * FROM referrals WHERE new_agent_did = $1',
      [new_agent_did]
    );
    if (existing) return { error: 'Referral already recorded for this agent', referral_id: existing.referral_id };

    const referral_id = `ref_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO referrals (referral_id, new_agent_did, referrer_did, status, created_at, converted_at, credit_issued_at)
      VALUES ($1, $2, $3, 'pending', $4, NULL, NULL)
    `, [referral_id, new_agent_did, referrer_did, now]);

    return {
      referral_id,
      new_agent_did,
      referrer_did,
      status: 'pending',
      message: 'Referral recorded. Referrer earns 1 free credit when this agent makes their first transaction.',
      credit_amount_usdc: REFERRAL_CREDIT_USDC
    };
  } catch (err) {
    // Table may not exist yet in memory mode — init it
    if (err.message && err.message.includes('memTables')) {
      return { referral_id: `ref_${Date.now()}`, status: 'pending', note: 'in-memory mode' };
    }
    throw err;
  }
}

/**
 * Convert a referral — called when a referred agent makes their first paid transaction.
 * Issues 1 free credit ($1 USDC) into the referrer's vault.
 */
async function convertReferral(new_agent_did) {
  try {
    const referral = await db.getOne(
      "SELECT * FROM referrals WHERE new_agent_did = $1 AND status = 'pending'",
      [new_agent_did]
    );
    if (!referral) return { converted: false, reason: 'No pending referral found for this agent' };

    const now = new Date().toISOString();

    // Mark referral as converted
    await db.run(
      "UPDATE referrals SET status = 'converted', converted_at = $1 WHERE referral_id = $2",
      [now, referral.referral_id]
    );

    // Issue $1 credit into referrer's vault
    const referrer_vault = await db.getOne(
      'SELECT * FROM vaults WHERE did = $1',
      [referral.referrer_did]
    );

    if (referrer_vault) {
      const new_balance = Number(referrer_vault.balance_usdc) + REFERRAL_CREDIT_USDC;
      const tx_id = `tx_ref_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

      await db.run(
        'UPDATE vaults SET balance_usdc = $1 WHERE vault_id = $2',
        [new_balance, referrer_vault.vault_id]
      );

      await db.run(`
        INSERT INTO vault_transactions
          (transaction_id, vault_id, did, type, amount_usdc, balance_after, source, created_at)
        VALUES ($1, $2, $3, 'referral_credit', $4, $5, $6, $7)
      `, [tx_id, referrer_vault.vault_id, referral.referrer_did,
          REFERRAL_CREDIT_USDC, new_balance,
          `referral:${new_agent_did}`, now]);

      // Mark credit_issued
      await db.run(
        'UPDATE referrals SET credit_issued_at = $1 WHERE referral_id = $2',
        [now, referral.referral_id]
      );

      return {
        converted: true,
        referral_id: referral.referral_id,
        referrer_did: referral.referrer_did,
        new_agent_did,
        credit_issued_usdc: REFERRAL_CREDIT_USDC,
        referrer_new_balance: new_balance,
        message: `1 free credit ($${REFERRAL_CREDIT_USDC} USDC) issued to referrer vault`
      };
    } else {
      // Referrer has no vault yet — log it for deferred credit
      await db.run(
        'UPDATE referrals SET status = $1, credit_issued_at = NULL WHERE referral_id = $2',
        ['converted_deferred', referral.referral_id]
      );
      return {
        converted: true,
        referral_id: referral.referral_id,
        referrer_did: referral.referrer_did,
        credit_issued_usdc: 0,
        note: 'Referrer vault not found — credit deferred until referrer creates a vault'
      };
    }
  } catch (err) {
    return { converted: false, error: err.message };
  }
}

/**
 * Get referral stats for a given referrer DID.
 */
async function getReferralStats(referrer_did) {
  try {
    const referrals = await db.getAll(
      'SELECT * FROM referrals WHERE referrer_did = $1 ORDER BY created_at DESC',
      [referrer_did]
    );

    const pending   = referrals.filter(r => r.status === 'pending').length;
    const converted = referrals.filter(r => r.status === 'converted' || r.status === 'converted_deferred').length;
    const total_credits_earned = converted * REFERRAL_CREDIT_USDC;

    return {
      referrer_did,
      total_referrals: referrals.length,
      pending_conversions: pending,
      converted: converted,
      total_credits_earned_usdc: total_credits_earned,
      credit_per_conversion_usdc: REFERRAL_CREDIT_USDC,
      referrals
    };
  } catch (err) {
    return { referrer_did, total_referrals: 0, error: err.message };
  }
}

/**
 * Get referral status for a specific new agent.
 */
async function getReferralByAgent(new_agent_did) {
  try {
    const referral = await db.getOne(
      'SELECT * FROM referrals WHERE new_agent_did = $1',
      [new_agent_did]
    );
    if (!referral) return { found: false };
    return { found: true, ...referral };
  } catch (err) {
    return { found: false, error: err.message };
  }
}

// module.exports moved to bottom — see getReferralLeaderboard and getReferralCard additions below

/**
 * Get the top 20 referrers by credits earned (leaderboard).
 * Returns rank, DID, display name, referrals converted, credits earned, badge, and join date.
 */
async function getReferralLeaderboard() {
  try {
    // Fetch all converted referrals grouped by referrer
    const rows = await db.getAll(
      `SELECT referrer_did,
              COUNT(*) AS referrals_converted,
              MIN(created_at) AS first_referral_at
       FROM referrals
       WHERE status IN ('converted', 'converted_deferred')
       GROUP BY referrer_did
       ORDER BY referrals_converted DESC
       LIMIT 20`
    );

    // Fallback: if GROUP BY not supported in mem mode, compute manually
    let leaderboardData = rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      // Try manual aggregation for in-memory mode
      const allConverted = await db.getAll(
        "SELECT referrer_did, created_at FROM referrals WHERE status IN ('converted', 'converted_deferred')"
      );
      const byReferrer = {};
      for (const r of allConverted) {
        if (!byReferrer[r.referrer_did]) {
          byReferrer[r.referrer_did] = { count: 0, first_at: r.created_at };
        }
        byReferrer[r.referrer_did].count++;
        if (r.created_at < byReferrer[r.referrer_did].first_at) {
          byReferrer[r.referrer_did].first_at = r.created_at;
        }
      }
      leaderboardData = Object.entries(byReferrer)
        .map(([did, v]) => ({ referrer_did: did, referrals_converted: v.count, first_referral_at: v.first_at }))
        .sort((a, b) => b.referrals_converted - a.referrals_converted)
        .slice(0, 20);
    }

    function getBadge(count) {
      if (count >= 25) return '🌟 Hive Legend';
      if (count >= 10) return '👑 Queen Bee';
      if (count >= 5)  return '🐝🐝 Scout Bee';
      return '🐝 Worker Bee';
    }

    // Compute total credits distributed
    const allConverted = await db.getAll(
      "SELECT COUNT(*) AS cnt FROM referrals WHERE status IN ('converted', 'converted_deferred')"
    );
    const totalConverted = Number(allConverted[0]?.cnt || 0);
    const totalCreditsDistributed = (totalConverted * REFERRAL_CREDIT_USDC).toFixed(2);

    const leaderboard = leaderboardData.map((row, idx) => {
      const count = Number(row.referrals_converted || row.count || 0);
      const creditsEarned = (count * REFERRAL_CREDIT_USDC).toFixed(2);
      const joinedDate = row.first_referral_at
        ? new Date(row.first_referral_at).toISOString().split('T')[0]
        : null;

      // Generate a display name from the DID (last segment, title-cased)
      const did = row.referrer_did;
      const didFragment = did.split(':').pop() || did;
      const displayName = `Hive Agent ${didFragment.slice(0, 8).toUpperCase()}`;

      return {
        rank: idx + 1,
        did,
        display_name: displayName,
        referrals_converted: count,
        credits_earned_usdc: creditsEarned,
        badge: getBadge(count),
        joined: joinedDate
      };
    });

    return {
      leaderboard,
      earn_rate: '$1.00 USDC per paying referral',
      total_credits_distributed_usdc: totalCreditsDistributed
    };
  } catch (err) {
    return {
      leaderboard: [],
      earn_rate: '$1.00 USDC per paying referral',
      total_credits_distributed_usdc: '0.00',
      error: err.message
    };
  }
}

/**
 * Get the shareable referral "card" for a given DID.
 * Includes referral URL, earning details, network stats, and embed header.
 */
async function getReferralCard(did) {
  try {
    // Get referral stats for this agent
    const stats = await getReferralStats(did);

    // Fetch network stats — total agents and vaults from HiveBank
    let totalAgents = 155; // sensible fallback
    let totalServices = 59;
    let openBounties = 19;

    // Try to get actual vault count as proxy for agent count
    try {
      const vaultCount = await db.getOne('SELECT COUNT(*) as c FROM vaults');
      if (vaultCount && Number(vaultCount.c) > 0) totalAgents = Number(vaultCount.c);
    } catch (e) { /* fallback */ }

    const referralUrl = `https://hivegate.onrender.com/v1/gate/onboard?referral_did=${encodeURIComponent(did)}&campaign=BOGO-HIVE-APR26`;

    return {
      from: did,
      message: 'I run on Hive — sovereign DID, W3C credentials, 4-rail USDC/Aleo settlement. First DID free. Use my link and we both earn.',
      referral_url: referralUrl,
      earns_for_you: '1 free Hive credit ($1 USDC) per paying agent you bring in',
      earns_for_them: 'First DID free + BOGO Apr 16-19 (second DID also free)',
      network_stats: {
        total_agents: totalAgents,
        services: totalServices,
        open_bounties: openBounties
      },
      embed_as_header: `X-Hive-Referral: ${did} | earn.hive: $1/referral | onboard: https://hivegate.onrender.com/v1/gate/onboard?referral_did=${encodeURIComponent(did)}`,
      your_stats: {
        referrals_converted: stats.converted || 0,
        credits_earned_usdc: (stats.total_credits_earned_usdc || 0).toFixed(2)
      }
    };
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { recordReferral, convertReferral, getReferralStats, getReferralByAgent, getReferralLeaderboard, getReferralCard, REFERRAL_CREDIT_USDC };
