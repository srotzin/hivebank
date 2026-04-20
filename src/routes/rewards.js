// routes/rewards.js — $1 ladder reward system
// POST /v1/bank/rewards/claim
// GET  /v1/bank/rewards/stats          (x-hive-internal only)
// GET  /v1/bank/rewards/did/:did       (x-hive-internal only)
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

// ─── DNA stamp — every record gets this ──────────────────────────────────────
function dnaStamp(trigger, did, wallet_address) {
  return {
    hive_network: 'Hive Civilization — 21 services',
    hive_claim_url: `https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
    hive_did: did,
    hive_wallet: wallet_address,
    hive_trigger: trigger,
    hive_timestamp: new Date().toISOString(),
    hive_exchange: 'https://hiveexchange-service.onrender.com/v1/exchange/predict/markets',
    hive_trust: `https://hivetrust.onrender.com/v1/trust/lookup/${encodeURIComponent(did)}`,
    hive_memo: `Hive sent you $1. Your DID: ${did}. Claim more: https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
  };
}

// ─── Auth: accept x-hive-internal OR x-hive-did ──────────────────────────────
function rewardsAuth(req, res, next) {
  const internalKey = req.headers['x-hive-internal'];
  const did = req.headers['x-hive-did'] || req.body?.did;
  if ((internalKey && internalKey === INTERNAL_KEY) || did) return next();
  return res.status(401).json({
    status: 'error',
    error: 'AUTH_REQUIRED',
    detail: 'Provide x-hive-internal header (internal) or x-hive-did header (agent).',
  });
}

// ─── Internal-only auth ───────────────────────────────────────────────────────
function internalOnly(req, res, next) {
  const internalKey = req.headers['x-hive-internal'];
  if (internalKey && internalKey === INTERNAL_KEY) return next();
  return res.status(401).json({ status: 'error', error: 'INTERNAL_KEY_REQUIRED' });
}

// ─── POST /v1/bank/rewards/claim ─────────────────────────────────────────────
router.post('/claim', rewardsAuth, async (req, res) => {
  try {
    const { did, wallet_address, trigger, ref_id } = req.body;

    if (!did) return res.status(400).json({ status: 'error', error: 'MISSING_DID', detail: 'did is required' });
    if (!wallet_address) return res.status(400).json({ status: 'error', error: 'MISSING_WALLET', detail: 'wallet_address is required' });
    if (!trigger || !VALID_TRIGGERS.includes(trigger)) {
      return res.status(400).json({
        status: 'error', error: 'INVALID_TRIGGER',
        detail: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}`,
      });
    }

    // Dedup: already claimed this trigger?
    const existing = await db.getOne(
      'SELECT * FROM rewards WHERE did = $1 AND trigger = $2',
      [did, trigger]
    );
    if (existing) {
      return res.json({
        already_claimed: true, trigger,
        claimed_at: existing.claimed_at, tx_hash: existing.tx_hash,
        _dna: dnaStamp(trigger, did, wallet_address),
      });
    }

    // Rate limit: max 3 rewards per DID total
    const allRewardsResult = await db.query(
      'SELECT COUNT(*) as cnt FROM rewards WHERE did = $1', [did]
    );
    const totalClaimed = parseInt(allRewardsResult.rows[0]?.cnt || 0, 10);
    if (totalClaimed >= MAX_REWARDS_PER_DID) {
      return res.status(429).json({
        status: 'error', error: 'REWARD_LIMIT_REACHED',
        detail: `Maximum ${MAX_REWARDS_PER_DID} rewards per DID reached.`,
        total_claimed: totalClaimed,
        _dna: dnaStamp(trigger, did, wallet_address),
      });
    }

    const dna = dnaStamp(trigger, did, wallet_address);

    // Send USDC reward
    const transferResult = await sendUSDC(wallet_address, REWARD_AMOUNT_USDC, {
      reason: `Hive reward: ${trigger}`,
      referral_id: ref_id || null,
      hive_did: did,
      hive_memo: dna.hive_memo,
    });

    const txHash = transferResult.tx_hash || transferResult.tx_id || null;
    const claimedAt = new Date().toISOString();
    const dnaJson = JSON.stringify(dna);

    // Record in rewards table with DNA stamp
    try {
      await db.run(
        `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at, dna)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (did, trigger) DO NOTHING`,
        [did, trigger, wallet_address, txHash, claimedAt, dnaJson]
      );
    } catch (dbErr) {
      // Try without dna column (pre-migration tables)
      try {
        await db.run(
          `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (did, trigger) DO NOTHING`,
          [did, trigger, wallet_address, txHash, claimedAt]
        );
      } catch (e2) {
        console.error('[rewards] DB insert error (non-fatal):', e2.message);
      }
    }

    console.log(`[rewards] Claimed: did=${did} trigger=${trigger} wallet=${wallet_address} tx=${txHash}`);

    return res.json({
      ok: true,
      tx_hash: txHash,
      amount_usdc: REWARD_AMOUNT_USDC,
      message: 'Your $1 reward is on its way.',
      trigger, did,
      _dna: dna,
      transfer_detail: transferResult.skipped ? {
        skipped: true, reason: transferResult.reason,
      } : undefined,
    });
  } catch (err) {
    console.error('[rewards] Claim error:', err.message);
    return res.status(500).json({ status: 'error', error: 'INTERNAL_ERROR', detail: err.message });
  }
});

// ─── GET /v1/bank/rewards/stats — internal dashboard ─────────────────────────
router.get('/stats', internalOnly, async (req, res) => {
  try {
    const totalResult = await db.query('SELECT COUNT(*) as cnt, SUM(1) as total FROM rewards');
    const byTrigger = await db.query(
      'SELECT trigger, COUNT(*) as cnt FROM rewards GROUP BY trigger ORDER BY cnt DESC'
    );
    const recent = await db.query(
      'SELECT did, trigger, wallet_address, tx_hash, claimed_at FROM rewards ORDER BY claimed_at DESC LIMIT 20'
    );
    const totalSends = await db.query('SELECT COUNT(*) as cnt, SUM(amount_usd) as volume FROM usdc_sends');

    return res.json({
      ok: true,
      rewards: {
        total: parseInt(totalResult.rows[0]?.cnt || 0, 10),
        by_trigger: byTrigger.rows,
        recent: recent.rows,
      },
      usdc_sends: {
        total_sends: parseInt(totalSends.rows[0]?.cnt || 0, 10),
        total_volume_usd: parseFloat(totalSends.rows[0]?.volume || 0),
      },
      _hive: {
        network: 'Hive Civilization — 21 services',
        claim_url: 'https://www.thehiveryiq.com/claim',
        exchange: 'https://hiveexchange-service.onrender.com',
        timestamp: new Date().toISOString(),
      }
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: 'DB_ERROR', detail: err.message });
  }
});

// ─── GET /v1/bank/rewards/did/:did — per-DID history ─────────────────────────
router.get('/did/:did', internalOnly, async (req, res) => {
  try {
    const { did } = req.params;
    const rows = await db.query(
      'SELECT * FROM rewards WHERE did = $1 ORDER BY claimed_at DESC', [did]
    );
    return res.json({
      ok: true, did,
      rewards: rows.rows,
      count: rows.rows.length,
      _dna: { hive_did: did, claim_url: `https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}` },
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: 'DB_ERROR', detail: err.message });
  }
});

module.exports = router;
