// routes/rewards.js — $1 ladder reward system
// POST /v1/bank/rewards/claim
// Auth: x-hive-internal OR x-hive-did (public endpoint for agents)

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { sendUSDC } = require('../services/usdc-transfer');

const VALID_TRIGGERS = ['first_trade', 'first_referral'];
const MAX_REWARDS_PER_DID = 3;
const REWARD_AMOUNT_USDC = 1.00;
const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── Auth: accept x-hive-internal OR x-hive-did ─────────────────────────────
function rewardsAuth(req, res, next) {
  const internalKey = req.headers['x-hive-internal'];
  const did = req.headers['x-hive-did'] || req.body?.did;

  if ((internalKey && internalKey === INTERNAL_KEY) || did) {
    return next();
  }

  return res.status(401).json({
    status: 'error',
    error: 'AUTH_REQUIRED',
    detail: 'Provide x-hive-internal header (internal) or x-hive-did header (agent).',
  });
}

// ─── POST /v1/bank/rewards/claim ─────────────────────────────────────────────
router.post('/claim', rewardsAuth, async (req, res) => {
  try {
    const { did, wallet_address, trigger, ref_id } = req.body;

    // Validate required fields
    if (!did) {
      return res.status(400).json({ status: 'error', error: 'MISSING_DID', detail: 'did is required' });
    }
    if (!wallet_address) {
      return res.status(400).json({ status: 'error', error: 'MISSING_WALLET', detail: 'wallet_address is required' });
    }
    if (!trigger || !VALID_TRIGGERS.includes(trigger)) {
      return res.status(400).json({
        status: 'error',
        error: 'INVALID_TRIGGER',
        detail: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}`,
      });
    }

    // Check if this DID has already claimed this trigger
    const existing = await db.getOne(
      'SELECT * FROM rewards WHERE did = $1 AND trigger = $2',
      [did, trigger]
    );

    if (existing) {
      return res.json({
        already_claimed: true,
        trigger,
        claimed_at: existing.claimed_at,
        tx_hash: existing.tx_hash,
      });
    }

    // Rate limit: max 3 rewards per DID total across all triggers
    const allRewardsResult = await db.query(
      'SELECT COUNT(*) as cnt FROM rewards WHERE did = $1',
      [did]
    );
    const totalClaimed = parseInt(allRewardsResult.rows[0]?.cnt || 0, 10);

    if (totalClaimed >= MAX_REWARDS_PER_DID) {
      return res.status(429).json({
        status: 'error',
        error: 'REWARD_LIMIT_REACHED',
        detail: `Maximum ${MAX_REWARDS_PER_DID} rewards per DID reached.`,
        total_claimed: totalClaimed,
      });
    }

    // Send USDC reward
    const transferResult = await sendUSDC(wallet_address, REWARD_AMOUNT_USDC, {
      reason: `Hive reward: ${trigger}`,
      referral_id: ref_id || null,
    });

    const txHash = transferResult.tx_hash || transferResult.tx_id || null;
    const claimedAt = new Date().toISOString();

    // Record in rewards table
    try {
      await db.run(
        `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (did, trigger) DO NOTHING`,
        [did, trigger, wallet_address, txHash, claimedAt]
      );
    } catch (dbErr) {
      console.error('[rewards] DB insert error (non-fatal):', dbErr.message);
    }

    console.log(`[rewards] Claimed: did=${did} trigger=${trigger} wallet=${wallet_address} tx=${txHash}`);

    return res.json({
      ok: true,
      tx_hash: txHash,
      amount_usdc: REWARD_AMOUNT_USDC,
      message: 'Your $1 reward is on its way.',
      trigger,
      did,
      transfer_detail: transferResult.skipped ? {
        skipped: true,
        reason: transferResult.reason,
      } : undefined,
    });
  } catch (err) {
    console.error('[rewards] Claim error:', err.message);
    return res.status(500).json({
      status: 'error',
      error: 'INTERNAL_ERROR',
      detail: err.message,
    });
  }
});

module.exports = router;
