const express = require('express');
const router = express.Router();
const cashback = require('../services/cashback');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

function requireInternal(req, res, next) {
  const key = req.headers['x-hive-internal'];
  if (key && key === INTERNAL_KEY) return next();
  return res.status(403).json({ error: 'Internal access required. Provide x-hive-internal header.' });
}

function extractDid(req) {
  if (req.body && req.body.did) return req.body.did;
  if (req.headers['x-agent-did']) return req.headers['x-agent-did'];
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer did:hive:')) {
    return authHeader.replace('Bearer ', '');
  }
  if (req.headers['x-hivetrust-did']) return req.headers['x-hivetrust-did'];
  return null;
}

// POST /v1/cashback/earn — Record cashback earned from a paid call (internal)
router.post('/earn', requireInternal, (req, res) => {
  const { did, amount_usdc, source_service, description } = req.body;
  if (!did || amount_usdc === undefined) {
    return res.status(400).json({ error: 'did and amount_usdc are required' });
  }

  const result = cashback.earn(did, amount_usdc, source_service, description);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result);
});

// POST /v1/cashback/spend — Spend cashback credits (internal)
router.post('/spend', requireInternal, (req, res) => {
  const { did, amount_usdc, service, description } = req.body;
  if (!did || amount_usdc === undefined) {
    return res.status(400).json({ error: 'did and amount_usdc are required' });
  }

  const result = cashback.spend(did, amount_usdc, service, description);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// GET /v1/cashback/balance/:did — Check cashback balance (requires DID auth)
router.get('/balance/:did', (req, res) => {
  const did = req.params.did;
  const authedDid = extractDid(req);
  const internalKey = req.headers['x-hive-internal'];
  const isInternal = internalKey && internalKey === INTERNAL_KEY;

  if (!isInternal && authedDid !== did) {
    return res.status(403).json({ error: 'DID mismatch. You can only view your own cashback balance.' });
  }

  const result = cashback.getBalance(did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

// GET /v1/cashback/stats — Platform-wide cashback stats (public)
router.get('/stats', (req, res) => {
  res.json(cashback.getStats());
});

// GET /v1/cashback/leaderboard — Top cashback earners (public)
router.get('/leaderboard', (req, res) => {
  res.json(cashback.getLeaderboard());
});

module.exports = router;
