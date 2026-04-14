const express = require('express');
const router = express.Router();
const vault = require('../services/vault');

router.post('/create', (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did is required' });

  const result = vault.createVault(did);
  if (result.error) return res.status(409).json(result);
  res.status(201).json(result);
});

router.post('/deposit', (req, res) => {
  const { did, amount_usdc, source } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = vault.deposit(did, amount_usdc, source);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/withdraw', (req, res) => {
  const { did, amount_usdc, destination_did } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = vault.withdraw(did, amount_usdc, destination_did);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/:did', (req, res) => {
  const result = vault.getVault(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/:did/history', (req, res) => {
  const result = vault.getHistory(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.post('/yield/accrue', (req, res) => {
  const result = vault.accrueYield();
  res.json(result);
});

module.exports = router;
