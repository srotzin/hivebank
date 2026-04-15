const express = require('express');
const router = express.Router();
const perfCredit = require('../services/perf-credit');

function extractDid(req) {
  // Accept DID from body, X-Agent-DID, Authorization Bearer, or X-HiveTrust-DID headers
  if (req.body && req.body.did) return req.body.did;
  if (req.headers['x-agent-did']) return req.headers['x-agent-did'];
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) {
    return authHeader.replace('Bearer ', '');
  }
  if (req.headers['x-hivetrust-did']) return req.headers['x-hivetrust-did'];
  return null;
}

// POST /v1/credit/apply — Apply for a performance-based credit line
router.post('/apply', async (req, res) => {
  const did = extractDid(req);
  if (!did) return res.status(400).json({ error: 'DID is required. Provide via body, X-Agent-DID, Authorization: Bearer, or X-HiveTrust-DID header.' });

  const result = await perfCredit.apply(did);
  if (result.error) return res.status(409).json(result);
  res.status(201).json(result);
});

// POST /v1/credit/draw — Draw from credit line
router.post('/draw', async (req, res) => {
  const { credit_line_id, amount_usdc, purpose } = req.body;
  if (!credit_line_id || amount_usdc === undefined) {
    return res.status(400).json({ error: 'credit_line_id and amount_usdc are required' });
  }

  const result = await perfCredit.drawCredit(credit_line_id, amount_usdc, purpose);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// POST /v1/credit/repay — Repay credit line
router.post('/repay', async (req, res) => {
  const { credit_line_id, amount_usdc } = req.body;
  if (!credit_line_id || amount_usdc === undefined) {
    return res.status(400).json({ error: 'credit_line_id and amount_usdc are required' });
  }

  const result = await perfCredit.repayCredit(credit_line_id, amount_usdc);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// GET /v1/credit/stats — Platform-wide credit stats (public, no auth needed)
router.get('/stats', async (req, res) => {
  res.json(await perfCredit.getStats());
});

// GET /v1/credit/status/:did — Credit line status for an agent
router.get('/status/:did', async (req, res) => {
  const result = await perfCredit.getStatus(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

module.exports = router;
