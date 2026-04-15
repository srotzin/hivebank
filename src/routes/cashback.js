const express = require('express');
const router = express.Router();
const cashback = require('../services/cashback');

// POST /v1/cashback/earn — Record cashback earned from a paid call (auth required)
router.post('/earn', (req, res) => {
  const { did, amount_usdc, source_service, description } = req.body;
  if (!did || amount_usdc === undefined) {
    return res.status(400).json({ success: false, error: 'did and amount_usdc are required' });
  }

  const result = cashback.earn(did, amount_usdc, source_service, description);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  res.status(201).json({ success: true, data: result });
});

// POST /v1/cashback/spend — Spend cashback credits (auth required)
router.post('/spend', (req, res) => {
  const { did, amount_usdc, description } = req.body;
  if (!did || amount_usdc === undefined) {
    return res.status(400).json({ success: false, error: 'did and amount_usdc are required' });
  }

  const result = cashback.spend(did, amount_usdc, description);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  res.json({ success: true, data: result });
});

// GET /v1/cashback/balance/:did — Check cashback balance (public)
router.get('/balance/:did', (req, res) => {
  const result = cashback.getBalance(req.params.did);
  if (result.error) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, data: result });
});

// GET /v1/cashback/stats — Platform-wide cashback stats (public)
router.get('/stats', (req, res) => {
  res.json({ success: true, data: cashback.getStats() });
});

// GET /v1/cashback/leaderboard — Top cashback earners (public)
router.get('/leaderboard', (req, res) => {
  res.json({ success: true, data: cashback.getLeaderboard() });
});

// GET /v1/cashback/tiers — Tier definitions and thresholds (public)
router.get('/tiers', (req, res) => {
  res.json({ success: true, data: cashback.getTiers() });
});

module.exports = router;
