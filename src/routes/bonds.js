const express = require('express');
const router = express.Router();
const bonds = require('../services/bonds');

// POST /v1/bonds/stake — Stake USDC into a HiveBond
router.post('/stake', (req, res) => {
  const { did, amount_usdc, lock_period_days } = req.body;
  if (!did || amount_usdc === undefined || lock_period_days === undefined) {
    return res.status(400).json({ error: 'did, amount_usdc, and lock_period_days are required' });
  }

  const result = bonds.stake(did, amount_usdc, lock_period_days);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result);
});

// POST /v1/bonds/unstake — Unstake a bond (early or matured)
router.post('/unstake', (req, res) => {
  const { bond_id } = req.body;
  if (!bond_id) return res.status(400).json({ error: 'bond_id is required' });

  const result = bonds.unstake(bond_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// GET /v1/bonds/stats — Platform-wide staking stats (public)
router.get('/stats', (req, res) => {
  res.json(bonds.getStats());
});

// GET /v1/bonds/rates — Current staking rates and tiers (public)
router.get('/rates', (req, res) => {
  res.json(bonds.getRates());
});

// GET /v1/bonds/portfolio/:did — Agent's bond portfolio
router.get('/portfolio/:did', (req, res) => {
  const result = bonds.getPortfolio(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

module.exports = router;
