/**
 * HiveBank Yield Vault — Routes
 * ==============================
 * POST /v1/bank/vault/deposit      — deposit USDC, create vault if new
 * GET  /v1/bank/vault/rates        — live APY from all 4 protocols (PUBLIC)
 * GET  /v1/bank/vault/stats        — TVL, yield, rebalance count (PUBLIC)
 * POST /v1/bank/vault/rebalance    — manual rebalance trigger (x-hive-internal required)
 * GET  /v1/bank/vault/:did         — vault balance, yield, allocation
 * POST /v1/bank/vault/withdraw     — burn shares, return USDC + yield
 *
 * Auth:
 *   deposit / withdraw  — did in body, fully public (no key required)
 *   rebalance trigger   — x-hive-internal header required
 *   rates / stats       — fully public
 */

'use strict';

const express = require('express');
const router  = express.Router();
const yieldVault = require('../services/yield-vault');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─────────────────────────────────────────────────────────────────────────────
//  PUBLIC ENDPOINTS (no auth)
// ─────────────────────────────────────────────────────────────────────────────

// GET /v1/bank/vault/rates — current APY from all 4 protocols + best protocol
router.get('/rates', async (req, res) => {
  try {
    const rates = await yieldVault.getRates();
    res.json({ success: true, data: rates });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch rates', detail: err.message });
  }
});

// GET /v1/bank/vault/stats — total TVL, yield earned, rebalance count
router.get('/stats', async (req, res) => {
  try {
    const stats = await yieldVault.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch stats', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DEPOSIT — public (did in body is the identity check)
// ─────────────────────────────────────────────────────────────────────────────

// POST /v1/bank/vault/deposit — body: { did, amount_usdc }
router.post('/deposit', async (req, res) => {
  const { did, amount_usdc } = req.body;

  if (!did) {
    return res.status(400).json({
      success: false,
      error: 'did is required',
      hint: 'Provide your Hive DID: e.g. "did:hive:your-agent-id"',
    });
  }
  if (amount_usdc === undefined || amount_usdc === null) {
    return res.status(400).json({ success: false, error: 'amount_usdc is required' });
  }
  if (isNaN(Number(amount_usdc)) || Number(amount_usdc) <= 0) {
    return res.status(400).json({ success: false, error: 'amount_usdc must be a positive number' });
  }

  try {
    const result = await yieldVault.deposit(did, amount_usdc);
    if (result.error) return res.status(400).json({ success: false, error: result.error });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Deposit failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  WITHDRAW — public (did in body)
// ─────────────────────────────────────────────────────────────────────────────

// POST /v1/bank/vault/withdraw — body: { did, amount_usdc }
router.post('/withdraw', async (req, res) => {
  const { did, amount_usdc } = req.body;

  if (!did) {
    return res.status(400).json({ success: false, error: 'did is required' });
  }
  if (amount_usdc === undefined || amount_usdc === null) {
    return res.status(400).json({ success: false, error: 'amount_usdc is required' });
  }
  if (isNaN(Number(amount_usdc)) || Number(amount_usdc) <= 0) {
    return res.status(400).json({ success: false, error: 'amount_usdc must be a positive number' });
  }

  try {
    const result = await yieldVault.withdraw(did, amount_usdc);
    if (result.error) return res.status(400).json({ success: false, error: result.error, data: result });
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Withdrawal failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MANUAL REBALANCE — requires x-hive-internal header
// ─────────────────────────────────────────────────────────────────────────────

// POST /v1/bank/vault/rebalance
router.post('/rebalance', async (req, res) => {
  const key = req.headers['x-hive-internal'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({
      success: false,
      error: 'INTERNAL_AUTH_REQUIRED',
      hint: 'Provide x-hive-internal header with the internal key',
    });
  }

  try {
    const result = await yieldVault.manualRebalance();
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: 'Rebalance failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET VAULT BY DID — public
// ─────────────────────────────────────────────────────────────────────────────

// GET /v1/bank/vault/:did — vault balance, current yield, protocol allocation
// NOTE: must be defined AFTER /rates, /stats, /deposit, /withdraw, /rebalance
//       to avoid those static path segments being matched as :did
router.get('/:did(*)', async (req, res) => {
  const { did } = req.params;

  if (!did) {
    return res.status(400).json({ success: false, error: 'did is required in path' });
  }

  try {
    const result = await yieldVault.getVaultBalance(did);
    if (result.error) return res.status(404).json({ success: false, error: result.error });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch vault', detail: err.message });
  }
});

module.exports = router;
