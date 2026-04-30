/**
 * HiveBank — Prospector Routes
 *
 * Prospector's Bonanza: gradient $5 / $3 / $1 rebates to first 100 qualified
 * cross-ecosystem agents that complete 3+ paid x402 calls into Hive surfaces
 * within a 30-day window.
 *
 * Spectral Cover: every payout runs the full SHOD 6-layer guard
 * (KILL_SWITCH, ALLOWLIST, DAILY_CAP, PER_RECIPIENT, SPECTRAL, TRUST)
 * with per-route state, plus SZOA Ed25519 ZK ticket binding minted by
 * the hive-prospector-qualifier service. No bypasses of the post
 * 2026-04-25 hardening — admit just narrows the L1 allowlist to
 * one DID/address pair for one claim.
 *
 * GET  /v1/bank/prospector/state         — Public. Slots remaining + tier breakdown.
 * POST /v1/bank/prospector/claim         — Public. Agent claims its slot.
 *                                          Requires qualification_token (HMAC, qualifier-issued)
 *                                          AND spectral-zk-ticket header (Ed25519, HiveTrust-signed).
 * POST /v1/bank/prospector/admit         — Internal-only. Qualifier service calls this when
 *                                          a fresh DID has met the 3-paid-call threshold.
 *                                          Adds DID/address to per-route L1 allowlist + persists JTI.
 * GET  /v1/bank/prospector/leaderboard   — Public. Top claimed slots, tier, tx hash, claim time.
 */

const express = require('express');
const router = express.Router();
const prospector = require('../services/prospector');

// Internal-only guard — admit can only be called by the qualifier service.
// Same pattern as referral/convert. Leaked-key purge 2026-04-25: lazy read,
// fail closed if env missing.
const { getInternalKey } = require('../lib/internal-key');

function requireInternal(req, res, next) {
  const key = req.headers['x-hive-internal'];
  if (!key || key !== getInternalKey()) {
    return res.status(403).json({ error: 'Forbidden — internal service call required' });
  }
  next();
}

// Feature flag — every prospector endpoint 503s if not enabled.
function requireProspectorEnabled(req, res, next) {
  if (process.env.PROSPECTOR_ENABLED !== 'true') {
    return res.status(503).json({
      error: 'prospector_disabled',
      detail: 'Prospector\'s Bonanza is not currently enabled on this instance.',
    });
  }
  next();
}

// GET /v1/bank/prospector/state — slot pool snapshot (PUBLIC)
router.get('/state', requireProspectorEnabled, async (req, res) => {
  try {
    const state = await prospector.getState();
    res.json(state);
  } catch (e) {
    res.status(500).json({ error: 'state_failed', detail: e.message });
  }
});

// GET /v1/bank/prospector/leaderboard — paid claims, descending by paid_at (PUBLIC)
router.get('/leaderboard', requireProspectorEnabled, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const result = await prospector.getLeaderboard({ limit });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'leaderboard_failed', detail: e.message });
  }
});

// POST /v1/bank/prospector/admit — qualifier service registers a qualified DID/address (INTERNAL ONLY)
//
// Body: { did, address, qualification_token }
//   qualification_token is HMAC-signed by the qualifier service using
//   PROSPECTOR_QUALIFIER_SECRET (shared secret). Token payload includes
//   { did, address, qualifier_did, paid_calls, issued_at, jti, exp }.
//
// On success: DID + address added to per-route L1 allowlist (in-memory),
// admit row persisted to prospector_admits keyed by jti for replay protection.
router.post('/admit', requireProspectorEnabled, requireInternal, async (req, res) => {
  const { did, address, qualification_token } = req.body || {};
  if (!did || !address || !qualification_token) {
    return res.status(400).json({
      error: 'bad_request',
      detail: 'did, address, and qualification_token are required',
    });
  }

  try {
    const result = await prospector.admit({ did, address, qualification_token });
    if (!result.ok) {
      return res.status(result.status || 400).json(result);
    }
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: 'admit_failed', detail: e.message });
  }
});

// POST /v1/bank/prospector/claim — agent claims its prospector slot (PUBLIC)
//
// Body: { did, address, qualification_token, attribution? }
// Headers:
//   spectral-zk-ticket: <base64url JSON, Ed25519-signed by HiveTrust issuer>
//
// Flow:
//   1. Verify qualification_token (HMAC, must match an admit row's jti)
//   2. Verify spectral-zk-ticket present (SZOA verifier runs inside sendUSDC)
//   3. Allocate next slot (gold/silver/bronze gradient)
//   4. Pass through outboundGuard.checkOutbound with route='prospector'
//      — runs full SHOD 6-layer with per-route state
//   5. sendUSDC with route='prospector' + spectralTicket
//   6. Persist claim row, remove DID/address from allowlist (single-use)
//
// On L4 SPECTRAL block (HIGH_VIOLET observed): claim is recorded as
// status='blocked' with block_code/block_detail; no payout, no allowlist drain,
// retry is allowed once spectral ring cools.
router.post('/claim', requireProspectorEnabled, async (req, res) => {
  const { did, address, qualification_token, attribution } = req.body || {};

  if (!did || !address || !qualification_token) {
    return res.status(400).json({
      error: 'bad_request',
      detail: 'did, address, and qualification_token are required',
    });
  }

  const spectralZkTicket = req.get('spectral-zk-ticket') || req.get('x-spectral-zk-ticket') || null;
  if (!spectralZkTicket) {
    return res.status(401).json({
      error: 'spectral_ticket_required',
      detail: 'Prospector route requires a HiveTrust-signed Ed25519 ZK ticket in the spectral-zk-ticket header. The qualifier service mints this ticket alongside the qualification_token.',
    });
  }

  try {
    const result = await prospector.claim({
      did,
      address,
      qualification_token,
      spectral_zk_ticket: spectralZkTicket,
      attribution: attribution || null,
    });

    // Map service-level status codes to HTTP
    if (result.status === 'blocked') {
      // Guard or spectral block — claim was recorded but no payout
      return res.status(409).json(result);
    }
    if (result.status === 'rejected') {
      // Bad token, replay, or already-claimed
      return res.status(result.http_status || 400).json(result);
    }
    if (result.status === 'deferred') {
      // Cap or spectral cooldown — retry later
      return res.status(429).json(result);
    }
    // Default: paid
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: 'claim_failed', detail: e.message });
  }
});

module.exports = router;
