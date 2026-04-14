const express = require('express');
const router = express.Router();
const budget = require('../services/budget');

router.post('/create', (req, res) => {
  const { orchestrator_did, child_did, rules } = req.body;
  if (!orchestrator_did || !child_did || !rules) {
    return res.status(400).json({ error: 'orchestrator_did, child_did, and rules are required' });
  }

  const result = budget.createDelegation(orchestrator_did, child_did, rules);
  if (result.error) return res.status(400).json(result);
  res.status(201).json(result);
});

router.post('/evaluate', (req, res) => {
  const { child_did, counterparty_did, amount_usdc, category } = req.body;
  if (!child_did || amount_usdc === undefined) {
    return res.status(400).json({ error: 'child_did and amount_usdc are required' });
  }

  const result = budget.evaluate(child_did, counterparty_did, amount_usdc, category);
  res.json(result);
});

router.get('/:orchestrator_did', (req, res) => {
  const result = budget.listDelegations(req.params.orchestrator_did);
  res.json(result);
});

router.post('/revoke/:delegation_id', (req, res) => {
  const result = budget.revokeDelegation(req.params.delegation_id);
  if (result.error) return res.status(404).json(result);
  res.json(result);
});

module.exports = router;
