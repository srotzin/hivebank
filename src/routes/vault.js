const express = require('express');
const router = express.Router();
const vault = require('../services/vault');

router.post('/create', async (req, res) => {
  const { did } = req.body;
  if (!did) return res.status(400).json({ error: 'did is required' });

  const result = await vault.createVault(did);
  if (result.error) return res.status(409).json(result);
  res.status(201).json(result);
});

router.post('/deposit', async (req, res) => {
  const { did, amount_usdc, source } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = await vault.deposit(did, amount_usdc, source);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.post('/withdraw', async (req, res) => {
  const { did, amount_usdc, destination_did } = req.body;
  if (!did || amount_usdc === undefined) return res.status(400).json({ error: 'did and amount_usdc are required' });

  const result = await vault.withdraw(did, amount_usdc, destination_did);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/:did', async (req, res) => {
  const result = await vault.getVault(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.get('/:did/history', async (req, res) => {
  const result = await vault.getHistory(req.params.did);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.post('/yield/accrue', async (req, res) => {
  const result = await vault.accrueYield();
  res.json(result);
});

router.post('/configure-reinvest', async (req, res) => {
  const { vault_id, reinvest_pct, reinvest_enabled } = req.body;
  if (!vault_id) return res.status(400).json({ error: 'vault_id is required' });
  if (reinvest_pct === undefined) return res.status(400).json({ error: 'reinvest_pct is required' });
  if (reinvest_enabled === undefined) return res.status(400).json({ error: 'reinvest_enabled is required' });

  const result = await vault.configureReinvest(vault_id, reinvest_pct, reinvest_enabled);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

router.get('/:id/reinvestment-stats', async (req, res) => {
  const result = await vault.getReinvestmentStats(req.params.id);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

router.post('/spend-budget', async (req, res) => {
  const { vault_id, amount, execution_id, purpose } = req.body;
  if (!vault_id) return res.status(400).json({ error: 'vault_id is required' });
  if (amount === undefined) return res.status(400).json({ error: 'amount is required' });

  const result = await vault.spendBudget(vault_id, amount, execution_id, purpose);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
