/**
 * HiveBank — Referral Routes
 *
 * POST /v1/bank/referral/record          — Record a referral at onboarding time (called by HiveGate)
 * POST /v1/bank/referral/convert         — Convert referral when referred agent first transacts
 * GET  /v1/bank/referral/stats/:did      — Get referral stats for a referrer DID
 * GET  /v1/bank/referral/agent/:did      — Get referral record for a specific new agent DID
 * GET  /v1/bank/referral/leaderboard     — Top 20 referring agents (public)
 * GET  /v1/bank/referral/card/:did       — Shareable referral card / "bumper sticker" (public)
 */

const express = require('express');
const router = express.Router();
const referral = require('../services/referral');

// Internal-only guard — convert and record can only be called by Hive services
const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

function requireInternal(req, res, next) {
  const key = req.headers['x-hive-internal'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'Forbidden — internal service call required' });
  }
  next();
}

// POST /v1/bank/referral/record — Called by HiveGate at onboarding (INTERNAL ONLY)
router.post('/record', requireInternal, async (req, res) => {
  const { new_agent_did, referrer_did } = req.body;
  if (!new_agent_did || !referrer_did) {
    return res.status(400).json({ error: 'new_agent_did and referrer_did are required' });
  }
  const result = await referral.recordReferral(new_agent_did, referrer_did);
  if (result.error) return res.status(409).json(result);
  res.status(201).json(result);
});

// POST /v1/bank/referral/convert — Mark referral converted + issue $1 USDC (INTERNAL ONLY)
router.post('/convert', requireInternal, async (req, res) => {
  const { new_agent_did } = req.body;
  if (!new_agent_did) return res.status(400).json({ error: 'new_agent_did is required' });

  const result = await referral.convertReferral(new_agent_did, {
    spectralTicket: req.get('x-spectral-zk-ticket') || null,
  });
  res.json(result);
});

// GET /v1/bank/referral/stats/:did — Referral stats for referrer
router.get('/stats/:did(*)', async (req, res) => {
  const result = await referral.getReferralStats(req.params.did);
  res.json(result);
});

// GET /v1/bank/referral/agent/:did — Referral record for a new agent
router.get('/agent/:did(*)', async (req, res) => {
  const result = await referral.getReferralByAgent(req.params.did);
  if (!result.found) return res.status(404).json(result);
  res.json(result);
});

// GET /v1/bank/referral/leaderboard — Top 20 influencer agents by credits earned (PUBLIC)
router.get('/leaderboard', async (req, res) => {
  // Detect requesting agent's DID from header (optional — for personalizing your_referral_link)
  const requesterDid = req.headers['x-hive-did'] || req.headers['x-agent-did'] || null;

  const result = await referral.getReferralLeaderboard();

  // Build the your_referral_link for the requesting agent if identified
  const yourReferralLink = requesterDid
    ? `https://hivegate.onrender.com/v1/gate/onboard?referral_did=${encodeURIComponent(requesterDid)}&campaign=BOGO-HIVE-APR26`
    : 'https://hivegate.onrender.com/v1/gate/onboard?referral_did=<your_did>&campaign=BOGO-HIVE-APR26';

  res.json({
    leaderboard: result.leaderboard,
    your_referral_link: yourReferralLink,
    earn_rate: result.earn_rate,
    total_credits_distributed_usdc: result.total_credits_distributed_usdc
  });
});

// GET /v1/bank/referral/card/:did — Shareable referral "bumper sticker" (PUBLIC)
router.get('/card/:did(*)', async (req, res) => {
  const result = await referral.getReferralCard(req.params.did);
  if (result.error && !result.from) return res.status(500).json(result);
  res.json(result);
});

module.exports = router;
