/**
 * HiveBank — Referral Routes
 *
 * POST /v1/bank/referral/record       — Record a referral at onboarding time (called by HiveGate)
 * POST /v1/bank/referral/convert      — Convert referral when referred agent first transacts
 * GET  /v1/bank/referral/stats/:did   — Get referral stats for a referrer DID
 * GET  /v1/bank/referral/agent/:did   — Get referral record for a specific new agent DID
 */

const express = require('express');
const router = express.Router();
const referral = require('../services/referral');

// POST /v1/bank/referral/record — Called by HiveGate at onboarding
router.post('/record', async (req, res) => {
  const { new_agent_did, referrer_did } = req.body;
  if (!new_agent_did || !referrer_did) {
    return res.status(400).json({ error: 'new_agent_did and referrer_did are required' });
  }
  const result = await referral.recordReferral(new_agent_did, referrer_did);
  if (result.error) return res.status(409).json(result);
  res.status(201).json(result);
});

// POST /v1/bank/referral/convert — Mark referral converted + issue credit
router.post('/convert', async (req, res) => {
  const { new_agent_did } = req.body;
  if (!new_agent_did) return res.status(400).json({ error: 'new_agent_did is required' });

  const result = await referral.convertReferral(new_agent_did);
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

module.exports = router;
