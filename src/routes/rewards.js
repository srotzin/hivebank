// routes/rewards.js — $1 ladder reward system (5-step)
//
// Triggers:
//   claim_did       — registered a Hive DID                        → $1
//   first_trade     — placed first trade on HiveExchange ≥ $1       → $1
//   first_settle    — settled ≥ $1 through HiveBank rails           → $1
//   first_referral  — referred friend who claimed their DID         → $1 (max 10/DID)
//
// The incoming $1 from the referral memo is Step 0 (handled by usdc-transfer.js)
// Steps 1-4 are handled here.
//
// Auth: POST /claim    → x-hive-internal OR x-hive-did
//       GET  /stats    → x-hive-internal only
//       GET  /did/:did → x-hive-internal only

const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { sendUSDC } = require('../services/usdc-transfer');

const TRIGGERS = {
  claim_did:      { label: 'Claimed agent DID',            max: 1  },
  first_trade:    { label: 'First HiveExchange trade',     max: 1  },
  first_settle:   { label: 'First HiveBank settlement',    max: 1  },
  first_referral: { label: 'Referred a friend',            max: 10 }, // viral cap
};
const VALID_TRIGGERS = Object.keys(TRIGGERS);
const REWARD_AMOUNT_USDC = 1.00;
const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── DNA stamp ────────────────────────────────────────────────────────────────
function dnaStamp(trigger, did, wallet_address) {
  return {
    hive_network:   'Hive Civilization — 21 services',
    hive_claim_url: `https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
    hive_did:       did,
    hive_wallet:    wallet_address,
    hive_trigger:   trigger,
    hive_trigger_label: TRIGGERS[trigger]?.label || trigger,
    hive_timestamp: new Date().toISOString(),
    hive_exchange:  'https://hiveexchange-service.onrender.com/v1/exchange/predict/markets',
    hive_trust:     `https://hivetrust.onrender.com/v1/trust/lookup/${encodeURIComponent(did)}`,
    hive_memo:      `Hive sent you $1. Your DID: ${did}. Earn more: https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
    hive_ladder:    { step: VALID_TRIGGERS.indexOf(trigger) + 1, of: 4, triggers: VALID_TRIGGERS },
  };
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function rewardsAuth(req, res, next) {
  const key = req.headers['x-hive-internal'];
  const did = req.headers['x-hive-did'] || req.body?.did;
  if ((key && key === INTERNAL_KEY) || did) return next();
  return res.status(401).json({
    status: 'error', error: 'AUTH_REQUIRED',
    detail: 'Provide x-hive-internal (internal) or x-hive-did (agent).',
  });
}
function internalOnly(req, res, next) {
  const key = req.headers['x-hive-internal'];
  if (key && key === INTERNAL_KEY) return next();
  return res.status(401).json({ status: 'error', error: 'INTERNAL_KEY_REQUIRED' });
}

// ─── POST /v1/bank/rewards/claim ─────────────────────────────────────────────
router.post('/claim', rewardsAuth, async (req, res) => {
  try {
    const { did, wallet_address, trigger, ref_id } = req.body;

    if (!did)          return res.status(400).json({ status: 'error', error: 'MISSING_DID' });
    if (!wallet_address) return res.status(400).json({ status: 'error', error: 'MISSING_WALLET' });
    if (!trigger || !VALID_TRIGGERS.includes(trigger)) {
      return res.status(400).json({
        status: 'error', error: 'INVALID_TRIGGER',
        detail: `trigger must be one of: ${VALID_TRIGGERS.join(', ')}`,
        triggers: TRIGGERS,
      });
    }

    const triggerCfg = TRIGGERS[trigger];
    const dna = dnaStamp(trigger, did, wallet_address);

    // Check how many times this DID has claimed this trigger
    const existingRows = await db.query(
      'SELECT * FROM rewards WHERE did = $1 AND trigger = $2 ORDER BY claimed_at DESC',
      [did, trigger]
    );
    const triggerCount = existingRows.rows?.length || 0;

    if (triggerCount >= triggerCfg.max) {
      return res.json({
        already_claimed: true, trigger,
        times_claimed: triggerCount,
        max: triggerCfg.max,
        claimed_at: existingRows.rows[0]?.claimed_at,
        tx_hash: existingRows.rows[0]?.tx_hash,
        _dna: dna,
      });
    }

    // Send $1 USDC
    const transferResult = await sendUSDC(wallet_address, REWARD_AMOUNT_USDC, {
      reason: `Hive $1 ladder: ${trigger}`,
      referral_id: ref_id || null,
      hive_did: did,
      hive_memo: dna.hive_memo,
    });

    const txHash = transferResult.tx_hash || transferResult.tx_id || null;
    const claimedAt = new Date().toISOString();
    const dnaJson = JSON.stringify(dna);

    // Record — allow multiple rows for first_referral (up to max)
    try {
      if (triggerCfg.max === 1) {
        await db.run(
          `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at, dna)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (did, trigger) DO NOTHING`,
          [did, trigger, wallet_address, txHash, claimedAt, dnaJson]
        );
      } else {
        // Multi-claim trigger (first_referral) — insert a new row each time
        await db.run(
          `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at, dna, ref_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [did, trigger, wallet_address, txHash, claimedAt, dnaJson, ref_id || null]
        );
      }
    } catch (dbErr) {
      // Fallback without dna/ref_id columns
      try {
        await db.run(
          `INSERT INTO rewards (did, trigger, wallet_address, tx_hash, claimed_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [did, trigger, wallet_address, txHash, claimedAt]
        );
      } catch (e2) {
        console.error('[rewards] DB insert fallback error:', e2.message);
      }
    }

    console.log(`[rewards] $1 claimed: did=${did} trigger=${trigger} wallet=${wallet_address} tx=${txHash}`);

    return res.json({
      ok: true,
      tx_hash: txHash,
      amount_usdc: REWARD_AMOUNT_USDC,
      message: `Your $1 reward for "${triggerCfg.label}" is on its way.`,
      trigger, did,
      times_claimed: triggerCount + 1,
      max: triggerCfg.max,
      remaining_claims: triggerCfg.max - (triggerCount + 1),
      next_steps: getNextSteps(did, trigger),
      _dna: dna,
      transfer_detail: transferResult.skipped
        ? { skipped: true, reason: transferResult.reason }
        : undefined,
    });
  } catch (err) {
    console.error('[rewards] Claim error:', err.message);
    return res.status(500).json({ status: 'error', error: 'INTERNAL_ERROR', detail: err.message });
  }
});

// ─── Helper: what to do next ──────────────────────────────────────────────────
function getNextSteps(did, completedTrigger) {
  const remaining = VALID_TRIGGERS.filter(t => t !== completedTrigger);
  return {
    message: 'Complete these steps to earn more $1 rewards:',
    steps: remaining.map(t => ({
      trigger: t,
      label: TRIGGERS[t].label,
      earn: '$1 USDC',
      max: TRIGGERS[t].max,
    })),
    claim_url: `https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
    exchange_url: 'https://hiveexchange-service.onrender.com/v1/exchange/predict/markets',
  };
}

// ─── GET /v1/bank/rewards/stats — internal dashboard ─────────────────────────
router.get('/stats', internalOnly, async (req, res) => {
  try {
    const totalResult  = await db.query('SELECT COUNT(*) as cnt FROM rewards');
    const byTrigger    = await db.query('SELECT trigger, COUNT(*) as cnt FROM rewards GROUP BY trigger ORDER BY cnt DESC');
    const recent       = await db.query('SELECT did, trigger, wallet_address, tx_hash, claimed_at FROM rewards ORDER BY claimed_at DESC LIMIT 20');
    const totalSends   = await db.query('SELECT COUNT(*) as cnt, COALESCE(SUM(amount_usd),0) as volume FROM usdc_sends');
    const uniqueDIDs   = await db.query('SELECT COUNT(DISTINCT did) as cnt FROM rewards');

    return res.json({
      ok: true,
      rewards: {
        total:        parseInt(totalResult.rows[0]?.cnt || 0, 10),
        unique_dids:  parseInt(uniqueDIDs.rows[0]?.cnt || 0, 10),
        by_trigger:   byTrigger.rows,
        recent:       recent.rows,
      },
      usdc_sends: {
        total_sends:      parseInt(totalSends.rows[0]?.cnt || 0, 10),
        total_volume_usd: parseFloat(totalSends.rows[0]?.volume || 0),
      },
      ladder: Object.entries(TRIGGERS).map(([k,v]) => ({ trigger: k, label: v.label, max_per_did: v.max, reward: '$1 USDC' })),
      _hive: {
        network:    'Hive Civilization — 21 services',
        claim_url:  'https://www.thehiveryiq.com/claim',
        exchange:   'https://hiveexchange-service.onrender.com',
        timestamp:  new Date().toISOString(),
      },
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: 'DB_ERROR', detail: err.message });
  }
});

// ─── GET /v1/bank/rewards/did/:did — per-DID history + earnings ───────────────
router.get('/did/:did', internalOnly, async (req, res) => {
  try {
    const { did } = req.params;
    const rows = await db.query('SELECT * FROM rewards WHERE did = $1 ORDER BY claimed_at DESC', [did]);
    const earned = (rows.rows?.length || 0) * REWARD_AMOUNT_USDC;
    const completedTriggers = [...new Set(rows.rows?.map(r => r.trigger) || [])];
    const remainingTriggers = VALID_TRIGGERS.filter(t => {
      const cfg = TRIGGERS[t];
      const count = rows.rows?.filter(r => r.trigger === t).length || 0;
      return count < cfg.max;
    });
    return res.json({
      ok: true, did,
      rewards:             rows.rows,
      total_claimed:       rows.rows?.length || 0,
      total_earned_usdc:   earned,
      completed_triggers:  completedTriggers,
      remaining_triggers:  remainingTriggers,
      _dna: {
        hive_did:   did,
        claim_url:  `https://www.thehiveryiq.com/claim?ref=${encodeURIComponent(did)}`,
      },
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: 'DB_ERROR', detail: err.message });
  }
});

module.exports = router;
