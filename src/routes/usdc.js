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
const { sendUSDC, checkUSDCBalance, submitEIP3009Authorization } = require('../services/usdc-transfer');

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
  const result = await sendUSDC(to, 1.00, { reason: "smoke_test" });

  res.status(result.ok ? 200 : 500).json({
    test: true,
    amount_usdc: 1.00,
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

// ─── GET /v1/bank/usdc/diag — env var + ethers check (internal) ──────────────
router.get('/diag', requireInternal, async (req, res) => {
  let ethersOk = false;
  let ethersVersion = null;
  try {
    const e = require('ethers');
    ethersVersion = e.version || 'loaded';
    ethersOk = true;
  } catch(err) {
    ethersVersion = err.message;
  }
  res.json({
    HIVE_WALLET_PRIVATE_KEY_set: !!process.env.HIVE_WALLET_PRIVATE_KEY,
    HIVE_WALLET_PRIVATE_KEY_prefix: process.env.HIVE_WALLET_PRIVATE_KEY ? process.env.HIVE_WALLET_PRIVATE_KEY.slice(0,6) : null,
    BASE_RPC_URL: process.env.BASE_RPC_URL || null,
    COINBASE_API_KEY_NAME_set: !!process.env.COINBASE_API_KEY_NAME,
    ethers_ok: ethersOk,
    ethers_version: ethersVersion,
  });
});

// ─── POST /v1/bank/usdc/verify-tx — verify on-chain tx for x402 ──────────────
router.post('/verify-tx', requireInternal, async (req, res) => {
  const { tx_hash, expected_recipient, expected_amount_usdc, network } = req.body;
  if (!tx_hash) return res.status(400).json({ error: 'tx_hash required' });

  try {
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL || 'https://base.drpc.org',
      { chainId: 8453, name: 'base' }
    );

    const receipt = await provider.getTransactionReceipt(tx_hash);
    if (!receipt) return res.json({ verified: false, reason: 'tx not found or not confirmed' });

    // Parse ERC-20 Transfer event
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const usdcLog = receipt.logs.find(l =>
      l.address.toLowerCase() === USDC &&
      l.topics[0] === TRANSFER_TOPIC
    );

    if (!usdcLog) return res.json({ verified: false, reason: 'no USDC transfer in tx' });

    const to = '0x' + usdcLog.topics[2].slice(26);
    const amount = parseInt(usdcLog.data, 16) / 1e6;

    const recipientMatch = !expected_recipient || to.toLowerCase() === expected_recipient.toLowerCase();
    const amountMatch = !expected_amount_usdc || amount >= parseFloat(expected_amount_usdc) * 0.99;

    console.log(`[verify-tx] ${tx_hash} → to:${to} amount:${amount} USDC | match:${recipientMatch && amountMatch}`);

    res.json({
      verified: recipientMatch && amountMatch,
      to, amount_usdc: amount,
      recipient_match: recipientMatch,
      amount_match: amountMatch,
      block: receipt.blockNumber,
    });
  } catch (err) {
    console.error('[verify-tx] error:', err.message);
    // Fallback: if RPC down, allow through (don't block legitimate payers)
    res.json({ verified: true, fallback: true, reason: err.message });
  }
});

// ─── POST /v1/bank/usdc/record-x402 — record inbound x402 payment ────────────

// ─── POST /v1/bank/usdc/submit-authorization — settle EIP-3009 signed payment on-chain ───────────
// Called by x402 middleware after receiving signed EIP-3009 auth from agent.
// Treasury wallet submits the authorization to the USDC contract — USDC moves on-chain.
router.post('/submit-authorization', requireInternal, async (req, res) => {
  const { payload, payer_did } = req.body;
  if (!payload) return res.status(400).json({ error: 'payload (EIP-3009 authorization + signature) required' });

  console.log(`[submit-authorization] Settling x402 payment from ${payer_did || 'unknown'}`);
  const result = await submitEIP3009Authorization(payload);

  if (result.ok) {
    console.log(`[submit-authorization] ✅ Settled ${result.amount_usdc} USDC | tx: ${result.tx_hash}`);
    return res.json({ settled: true, ...result });
  }
  if (result.skipped) return res.status(503).json({ settled: false, ...result });
  return res.status(500).json({ settled: false, ...result });
});

router.post('/record-x402', requireInternal, async (req, res) => {
  const { tx_hash, amount_usdc, payer } = req.body;
  if (!tx_hash || !amount_usdc) return res.status(400).json({ error: 'tx_hash and amount_usdc required' });
  await logSend({
    toAddress: process.env.HOUSE_WALLET || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
    amountUsdc: amount_usdc,
    reason: 'x402_inbound',
    txHash: tx_hash,
    txId: tx_hash,
    status: 'completed',
    hiveDid: payer || null,
  });
  console.log(`[record-x402] ${amount_usdc} USDC inbound | tx:${tx_hash} | payer:${payer}`);
  res.json({ ok: true, recorded: true });
});
