const express = require('express');
const router = express.Router();
const credit = require('../services/credit');

router.post('/apply', async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did is required' });

  const result = await credit.apply(did);
  if (result.error) return res.status(409).json(result);
  res.status(result.approved ? 201 : 200).json(result);
});

router.post('/draw', async (req, res) => {
  const { did, amount_usdc } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = await credit.draw(did, amount_usdc);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/repay', async (req, res) => {
  const { did, amount_usdc } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = await credit.repay(did, amount_usdc);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/:did', async (req, res) => {
  const result = await credit.getStatus(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/underwrite/:did', async (req, res) => {
  const result = await credit.underwrite(req.params.did);
  res.json(result);
});

module.exports = router;
