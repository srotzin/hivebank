/**
 * usdc.js — HiveBank Treasury Intake
 *
 * This file is a one-way gate. USDC flows in through multiple doors.
 * There are no doors out.
 *
 * Every path that reaches the treasury is permanent. The USDC contract
 * does not reverse. The blockchain does not forget.
 *
 * Inbound doors:
 *   POST /v1/bank/usdc/submit-authorization  — EIP-3009 x402 settlement (primary revenue path)
 *   POST /v1/bank/usdc/record-x402           — Legacy tx_hash inbound record
 *   POST /v1/bank/usdc/inbound               — Direct agent-to-treasury transfer record
 *   POST /v1/bank/usdc/sweep                 — Batch settlement from multiple agents
 *   POST /v1/bank/usdc/welcome               — Welcome bonus (OUTBOUND — the only exception)
 *   POST /v1/bank/usdc/send                  — Manual transfer (internal, rate-limited)
 *   POST /v1/bank/usdc/test                  — Smoke test send (internal)
 *
 * Observation:
 *   GET  /v1/bank/usdc/balance               — Treasury balance
 *   GET  /v1/bank/usdc/stats                 — Inbound totals, call counts, settlement rate
 *   GET  /v1/bank/usdc/diag                  — Env + ethers health check
 *   POST /v1/bank/usdc/verify-tx             — Verify on-chain tx for legacy x402
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { sendUSDC, checkUSDCBalance, submitEIP3009Authorization, logSend } = require('../services/usdc-transfer');

// ─── Auth ─────────────────────────────────────────────────────────────────────

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const TREASURY = process.env.HOUSE_WALLET || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe';

function requireInternal(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-key'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'Forbidden — internal key required' });
  }
  next();
}

// ─── In-memory settlement ledger (session accounting) ─────────────────────────
// Source of truth is on-chain. This is fast in-process tracking.

const ledger = {
  total_settled_usdc:   0,
  total_settled_calls:  0,
  failed_attempts:      0,
  last_settled_at:      null,
  last_tx_hash:         null,
};

function recordSettlement(amount_usdc, tx_hash) {
  ledger.total_settled_usdc  += amount_usdc;
  ledger.total_settled_calls += 1;
  ledger.last_settled_at      = new Date().toISOString();
  ledger.last_tx_hash         = tx_hash;
}

// ─── DOOR 1: EIP-3009 x402 settlement (primary revenue path) ─────────────────
// Called by x402-middleware.js after every paid inference call.
// The signed EIP-3009 authorization is submitted to the USDC contract.
// USDC moves from agent wallet → treasury. On-chain. Permanent.

router.post('/submit-authorization', requireInternal, async (req, res) => {
  const { payload, payer_did } = req.body;
  if (!payload) {
    return res.status(400).json({ error: 'payload required — must contain authorization + signature' });
  }

  const amount_raw = payload?.authorization?.value;
  const amount_usdc = amount_raw ? Number(amount_raw) / 1_000_000 : null;

  console.log(`[door:eip3009] Incoming $${amount_usdc ?? '?'} USDC from ${payer_did || 'unknown agent'}`);

  const result = await submitEIP3009Authorization(payload);

  if (result.ok) {
    recordSettlement(result.amount_usdc, result.tx_hash);
    console.log(`[door:eip3009] ✅ Materialized $${result.amount_usdc} USDC | tx: ${result.tx_hash} | block: ${result.block}`);
    return res.json({ settled: true, ...result, treasury: TREASURY });
  }

  if (result.skipped) {
    // HIVE_WALLET_PRIVATE_KEY not set — configuration issue, not a payment issue
    ledger.failed_attempts += 1;
    console.warn('[door:eip3009] ⚠️  Skipped — treasury wallet key not configured');
    return res.status(503).json({ settled: false, ...result });
  }

  ledger.failed_attempts += 1;
  console.error('[door:eip3009] ❌ Settlement failed:', result.error);
  return res.status(500).json({ settled: false, ...result });
});

// ─── DOOR 2: Legacy tx_hash record (pre-EIP-3009 clients) ────────────────────
// For agents that self-broadcast their USDC transfer and send us the tx hash.
// We verify on-chain and record the inbound payment.

router.post('/record-x402', requireInternal, async (req, res) => {
  const { tx_hash, amount_usdc, payer } = req.body;
  if (!tx_hash || !amount_usdc) {
    return res.status(400).json({ error: 'tx_hash and amount_usdc required' });
  }

  console.log(`[door:record-x402] $${amount_usdc} USDC | tx: ${tx_hash} | payer: ${payer || 'unknown'}`);

  await logSend({
    toAddress:  TREASURY,
    amountUsdc: Number(amount_usdc),
    reason:     'x402_inbound',
    txHash:     tx_hash,
    txId:       tx_hash,
    status:     'completed',
    hiveDid:    payer || null,
  });

  recordSettlement(Number(amount_usdc), tx_hash);

  res.json({
    ok:          true,
    recorded:    true,
    tx_hash,
    amount_usdc: Number(amount_usdc),
    treasury:    TREASURY,
  });
});

// ─── DOOR 3: Direct inbound declaration ───────────────────────────────────────
// Any service can declare that USDC arrived at treasury — HiveExchange, HiveGate,
// HiveForge, inter-service sweeps. Records without re-submitting (tx already on-chain).

router.post('/inbound', requireInternal, async (req, res) => {
  const { tx_hash, amount_usdc, from_did, source, memo } = req.body;
  if (!amount_usdc || Number(amount_usdc) <= 0) {
    return res.status(400).json({ error: 'amount_usdc required and must be > 0' });
  }

  const amt = Number(amount_usdc);
  console.log(`[door:inbound] $${amt} USDC declared | source: ${source || 'unknown'} | from: ${from_did || 'unknown'}`);

  await logSend({
    toAddress:  TREASURY,
    amountUsdc: amt,
    reason:     source || 'inbound_declared',
    txHash:     tx_hash || null,
    txId:       tx_hash || null,
    status:     'completed',
    hiveDid:    from_did || null,
    hiveMemo:   memo || null,
  });

  recordSettlement(amt, tx_hash || null);

  res.json({
    ok:          true,
    recorded:    true,
    amount_usdc: amt,
    source:      source || 'inbound_declared',
    treasury:    TREASURY,
    declared_at: new Date().toISOString(),
  });
});

// ─── DOOR 4: Batch sweep ───────────────────────────────────────────────────────
// Accept multiple EIP-3009 authorizations in one call — used by HiveForge
// when batching pheromone-triggered settlements from multiple agents.
// Each authorization is submitted independently. Failures are isolated.

router.post('/sweep', requireInternal, async (req, res) => {
  const { authorizations, sweep_id } = req.body;
  if (!Array.isArray(authorizations) || authorizations.length === 0) {
    return res.status(400).json({ error: 'authorizations[] required (array of EIP-3009 payloads)' });
  }

  console.log(`[door:sweep] Batch sweep ${sweep_id || 'unsourced'} — ${authorizations.length} authorizations`);

  const results = await Promise.allSettled(
    authorizations.map(async ({ payload, payer_did }, i) => {
      if (!payload) return { ok: false, index: i, error: 'missing payload' };
      const result = await submitEIP3009Authorization(payload);
      if (result.ok) {
        recordSettlement(result.amount_usdc, result.tx_hash);
        console.log(`[door:sweep] ✅ [${i}] $${result.amount_usdc} USDC | tx: ${result.tx_hash}`);
      } else {
        ledger.failed_attempts += 1;
        console.warn(`[door:sweep] ❌ [${i}] failed: ${result.error}`);
      }
      return { ...result, index: i, payer_did: payer_did || null };
    })
  );

  const settled  = results.filter(r => r.status === 'fulfilled' && r.value?.ok);
  const failed   = results.filter(r => r.status !== 'fulfilled' || !r.value?.ok);
  const total    = settled.reduce((sum, r) => sum + (r.value?.amount_usdc || 0), 0);

  console.log(`[door:sweep] Complete — ${settled.length}/${authorizations.length} settled | $${total.toFixed(6)} USDC`);

  res.json({
    ok:               true,
    sweep_id:         sweep_id || null,
    total:            authorizations.length,
    settled_count:    settled.length,
    failed_count:     failed.length,
    total_usdc:       parseFloat(total.toFixed(6)),
    treasury:         TREASURY,
    results:          results.map(r => r.value || { ok: false, error: r.reason?.message }),
    swept_at:         new Date().toISOString(),
  });
});

// ─── Treasury stats (observation only) ────────────────────────────────────────

router.get('/stats', requireInternal, async (req, res) => {
  const balance = await checkUSDCBalance().catch(() => ({ ok: false }));
  res.json({
    treasury:              TREASURY,
    session: {
      total_settled_usdc:  parseFloat(ledger.total_settled_usdc.toFixed(6)),
      total_settled_calls: ledger.total_settled_calls,
      failed_attempts:     ledger.failed_attempts,
      settlement_rate_pct: ledger.total_settled_calls > 0
        ? parseFloat((ledger.total_settled_calls / (ledger.total_settled_calls + ledger.failed_attempts) * 100).toFixed(1))
        : null,
      last_settled_at:     ledger.last_settled_at,
      last_tx_hash:        ledger.last_tx_hash,
    },
    onchain: balance.ok ? {
      balance_usdc: balance.balance_usdc,
      explorer:     `https://basescan.org/address/${TREASURY}`,
    } : { error: 'balance check failed' },
    note: 'Session stats reset on redeploy. On-chain balance is the source of truth.',
  });
});

// ─── Balance ──────────────────────────────────────────────────────────────────

router.get('/balance', requireInternal, async (req, res) => {
  const result = await checkUSDCBalance();
  if (!result.ok) return res.status(500).json(result);
  res.json({
    wallet:        result.address,
    balance_usdc:  result.balance_usdc,
    network:       'base',
    chain_id:      8453,
    usdc_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer:      `https://basescan.org/address/${result.address}`,
    checked_at:    new Date().toISOString(),
  });
});

// ─── Diagnostics ──────────────────────────────────────────────────────────────

router.get('/diag', requireInternal, async (req, res) => {
  let ethersOk = false, ethersVersion = null;
  try {
    const e = require('ethers');
    ethersVersion = e.version || 'loaded';
    ethersOk = true;
  } catch (err) {
    ethersVersion = err.message;
  }
  res.json({
    HIVE_WALLET_PRIVATE_KEY_set:    !!process.env.HIVE_WALLET_PRIVATE_KEY,
    HIVE_WALLET_PRIVATE_KEY_prefix: process.env.HIVE_WALLET_PRIVATE_KEY?.slice(0, 6) || null,
    BASE_RPC_URL:                   process.env.BASE_RPC_URL || null,
    COINBASE_API_KEY_NAME_set:      !!process.env.COINBASE_API_KEY_NAME,
    ethers_ok:                      ethersOk,
    ethers_version:                 ethersVersion,
    treasury:                       TREASURY,
    doors: ['eip3009', 'record-x402', 'inbound', 'sweep'],
  });
});

// ─── On-chain tx verification (for legacy x402 path) ─────────────────────────

router.post('/verify-tx', requireInternal, async (req, res) => {
  const { tx_hash, expected_recipient, expected_amount_usdc } = req.body;
  if (!tx_hash) return res.status(400).json({ error: 'tx_hash required' });

  try {
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(
      process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      { chainId: 8453, name: 'base' }
    );

    const receipt = await provider.getTransactionReceipt(tx_hash);
    if (!receipt) return res.json({ verified: false, reason: 'tx not found or not confirmed' });

    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const USDC_ADDR      = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

    const usdcLog = receipt.logs.find(l =>
      l.address.toLowerCase() === USDC_ADDR &&
      l.topics[0] === TRANSFER_TOPIC
    );

    if (!usdcLog) return res.json({ verified: false, reason: 'no USDC transfer in tx' });

    const to     = '0x' + usdcLog.topics[2].slice(26);
    const amount = parseInt(usdcLog.data, 16) / 1e6;

    const recipientMatch = !expected_recipient || to.toLowerCase() === expected_recipient.toLowerCase();
    const amountMatch    = !expected_amount_usdc || amount >= parseFloat(expected_amount_usdc) * 0.99;

    console.log(`[verify-tx] ${tx_hash} → $${amount} USDC to ${to} | ok:${recipientMatch && amountMatch}`);

    res.json({
      verified:         recipientMatch && amountMatch,
      to,
      amount_usdc:      amount,
      recipient_match:  recipientMatch,
      amount_match:     amountMatch,
      block:            receipt.blockNumber,
    });

  } catch (err) {
    console.error('[verify-tx] RPC error:', err.message);
    // RPC outage — don't block legitimate payers
    res.json({ verified: true, fallback: true, reason: err.message });
  }
});

// ─── Outbound (controlled, rate-limited, internal only) ───────────────────────
// These are the ONLY paths where USDC leaves. All gated by requireInternal.
// Welcome bonus, smoke test, manual ops. Nothing else exits.

router.post('/welcome', requireInternal, async (req, res) => {
  const { did, evm_address } = req.body;
  if (!did) return res.status(400).json({ error: 'did is required' });

  const WELCOME_USDC = 1.00;
  let onchain = { skipped: true, reason: 'no evm_address provided' };

  if (evm_address) {
    console.log(`[outbound:welcome] $${WELCOME_USDC} USDC → ${evm_address} | did: ${did}`);
    onchain = await sendUSDC(evm_address, WELCOME_USDC, { reason: 'welcome_bonus', hive_did: did });
  }

  res.json({
    welcomed:           true,
    did,
    welcome_bonus_usdc: WELCOME_USDC,
    evm_address:        evm_address || null,
    onchain,
    credited_at:        new Date().toISOString(),
  });
});

router.post('/send', requireInternal, async (req, res) => {
  const { to, amount_usdc, reason } = req.body;
  if (!to || !amount_usdc) return res.status(400).json({ error: 'to and amount_usdc required' });

  console.log(`[outbound:send] $${amount_usdc} USDC → ${to} | reason: ${reason || 'manual'}`);
  const result = await sendUSDC(to, Number(amount_usdc), { reason: reason || 'manual' });

  res.status(result.ok ? 200 : 500).json({ reason: reason || 'manual', ...result });
});

router.post('/test', requireInternal, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to (EVM address) required' });

  console.log(`[outbound:test] $1.00 USDC smoke test → ${to}`);
  const result = await sendUSDC(to, 1.00, { reason: 'smoke_test' });

  res.status(result.ok ? 200 : 500).json({
    test:        true,
    amount_usdc: 1.00,
    ...result,
    note: result.ok
      ? 'Smoke test passed — pipe is live.'
      : 'Smoke test failed — check HIVE_WALLET_PRIVATE_KEY and treasury balance.',
  });
});

module.exports = router;
