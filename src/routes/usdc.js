/**
 * usdc.js — HiveBank USDC On-Chain Management Routes
 *
 * GET  /v1/bank/usdc/balance          — Check Hive wallet USDC balance on Base L2
 * POST /v1/bank/usdc/test             — Send 0.01 USDC smoke test (internal only)
 * POST /v1/bank/usdc/send             — Send arbitrary USDC to an EVM address (internal only)
 * POST /v1/bank/usdc/welcome          — Issue welcome bonus + attempt on-chain send
 *
 * All write routes require x-hive-internal header.
 */

const express = require('express');
const router  = express.Router();
const { sendUSDC, checkUSDCBalance, testTransfer } = require('../services/usdc-transfer');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

function requireInternal(req, res, next) {
  const key = req.headers['x-hive-internal'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'Forbidden — x-hive-internal required' });
  }
  next();
}

// ─── GET /v1/bank/usdc/balance — wallet balance (internal) ───────────────────
router.get('/balance', requireInternal, async (req, res) => {
  const result = await checkUSDCBalance();
  if (!result.ok) return res.status(500).json(result);
  res.json({
    wallet: result.address,
    balance_usdc: result.balance_usdc,
    network: 'base',
    chain_id: 8453,
    usdc_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: `https://basescan.org/address/${result.address}`,
    checked_at: new Date().toISOString(),
  });
});

// ─── POST /v1/bank/usdc/test — 0.01 USDC smoke test ─────────────────────────
router.post('/test', requireInternal, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to (EVM address) is required' });

  console.log(`[USDC/test] Smoke test → ${to}`);
  const result = await testTransfer(to);

  res.status(result.ok ? 200 : 500).json({
    test: true,
    amount_usdc: 0.01,
    ...result,
    note: result.ok
      ? 'Smoke test passed — pipe is live. You can now enable full welcome bonuses.'
      : 'Smoke test failed — check HIVE_WALLET_PRIVATE_KEY env var and wallet USDC balance.',
  });
});

// ─── POST /v1/bank/usdc/send — arbitrary send (internal) ─────────────────────
router.post('/send', requireInternal, async (req, res) => {
  const { to, amount_usdc, reason } = req.body;
  if (!to || !amount_usdc) {
    return res.status(400).json({ error: 'to and amount_usdc are required' });
  }

  console.log(`[USDC/send] ${amount_usdc} USDC → ${to} | reason: ${reason || 'manual'}`);
  const result = await sendUSDC(to, Number(amount_usdc));

  res.status(result.ok ? 200 : 500).json({
    reason: reason || 'manual_transfer',
    ...result,
  });
});

// ─── POST /v1/bank/usdc/welcome — welcome bonus for new agent ────────────────
// Called when a new agent onboards. Sends $1 USDC to their EVM address (if provided)
// AND records in the in-memory ledger. Safe to call without an evm_address — falls
// back to ledger-only credit.
router.post('/welcome', requireInternal, async (req, res) => {
  const { did, evm_address } = req.body;
  if (!did) return res.status(400).json({ error: 'did is required' });

  const WELCOME_USDC = 1.00;
  let onchain = { skipped: true, reason: 'no evm_address provided' };

  if (evm_address) {
    console.log(`[USDC/welcome] Sending ${WELCOME_USDC} USDC welcome bonus → ${evm_address} for ${did}`);
    onchain = await sendUSDC(evm_address, WELCOME_USDC);
    if (!onchain.ok && !onchain.skipped) {
      console.warn('[USDC/welcome] On-chain failed — falling back to ledger-only credit');
    }
  }

  res.json({
    welcomed: true,
    did,
    welcome_bonus_usdc: WELCOME_USDC,
    evm_address: evm_address || null,
    onchain,
    fallback: 'Ledger credit always applied regardless of on-chain status',
    note: onchain.ok
      ? `$${WELCOME_USDC} USDC sent on-chain — tx: ${onchain.tx_hash}`
      : `$${WELCOME_USDC} USDC credited to ledger (on-chain pending EVM address)`,
    credited_at: new Date().toISOString(),
  });
});

module.exports = router;
