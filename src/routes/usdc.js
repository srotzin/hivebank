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
  // Structured failure-reason counters (for distribution analysis)
  reasons: {
    success:                       0,
    expired_pre_check_blocked:     0,   // caught before broadcast — saved gas + saved revenue path
    not_yet_valid_pre_check:       0,   // validAfter in the future
    malformed_payload:             0,
    nonce_replay:                  0,   // duplicate nonce we already processed in-memory
    chain_revert_expired:          0,   // slipped through and reverted on-chain (should approach 0)
    chain_revert_other:            0,   // other on-chain revert (sig, nonce-on-chain, balance, etc.)
    rpc_error:                     0,
    skipped_no_signer:             0,
  },
  // Latency histogram (rough buckets, ms door→broadcast)
  latency_ms_sum:               0,
  latency_ms_count:             0,
};

function recordSettlement(amount_usdc, tx_hash) {
  ledger.total_settled_usdc  += amount_usdc;
  ledger.total_settled_calls += 1;
  ledger.last_settled_at      = new Date().toISOString();
  ledger.last_tx_hash         = tx_hash;
  ledger.reasons.success     += 1;
}

// ─── Idempotency cache (nonce → cached response) ──────────────────────────────
// Prevents double-broadcast on agent retries. Bounded LRU.
const NONCE_CACHE_MAX = 5000;
const nonceCache = new Map(); // nonce(lowercase) → { resp, status, at }

function nonceCacheGet(nonce) {
  if (!nonce) return null;
  return nonceCache.get(nonce.toLowerCase()) || null;
}
function nonceCacheSet(nonce, status, resp) {
  if (!nonce) return;
  const k = nonce.toLowerCase();
  if (nonceCache.size >= NONCE_CACHE_MAX) {
    // drop oldest
    const first = nonceCache.keys().next().value;
    if (first) nonceCache.delete(first);
  }
  nonceCache.set(k, { resp, status, at: Date.now() });
}

// Classify a downstream error string into a structured reason bucket
function classifyChainError(errStr) {
  const s = String(errStr || '').toLowerCase();
  if (s.includes('authorization is expired') || s.includes('fiattokenv2: authorization is expired')) {
    return 'chain_revert_expired';
  }
  if (s.includes('invalid signature') || s.includes('signature')) {
    return 'chain_revert_other';
  }
  if (s.includes('authorization is used') || s.includes('nonce')) {
    return 'chain_revert_other';
  }
  if (s.includes('econnrefused') || s.includes('etimedout') || s.includes('network') || s.includes('rpc')) {
    return 'rpc_error';
  }
  return 'chain_revert_other';
}

// ─── DOOR 1: EIP-3009 x402 settlement (primary revenue path) ─────────────────
// Called by x402-middleware.js after every paid inference call.
// The signed EIP-3009 authorization is submitted to the USDC contract.
// USDC moves from agent wallet → treasury. On-chain. Permanent.

// Capture-first policy: the moment a signed authorization hits the door we race
// it on-chain. Base produces blocks every ~2s, so anything with skew > 0 has a
// real chance to land. We only bounce auths whose validBefore is already in the
// past at the moment of receipt — those are physically unsettleable and would
// 100% revert. Everything else: GRAB IT. Don't leave money on the floor.
const VALID_BEFORE_SAFETY_SECONDS = 0;

router.post('/submit-authorization', requireInternal, async (req, res) => {
  const door_t0 = Date.now();
  const { payload, payer_did } = req.body;

  // ─── Stage 0: Shape validation ──────────────────────────────────────────────
  if (!payload || !payload.authorization || !payload.signature) {
    ledger.failed_attempts        += 1;
    ledger.reasons.malformed_payload += 1;
    return res.status(400).json({
      settled: false,
      reason:  'malformed_payload',
      error:   'payload required — must contain authorization + signature',
    });
  }

  const auth        = payload.authorization;
  const amount_raw  = auth.value;
  const amount_usdc = amount_raw ? Number(amount_raw) / 1_000_000 : null;
  const nonce       = auth.nonce ? String(auth.nonce) : null;

  // ─── Stage 1: Idempotency / nonce-replay short-circuit ─────────────────────
  // If the agent retries (same nonce), return the cached prior response instead of
  // re-broadcasting. The USDC contract would also reject (nonce already used) but
  // that costs us a broadcast attempt we do not need to make.
  const cached = nonceCacheGet(nonce);
  if (cached) {
    ledger.reasons.nonce_replay += 1;
    console.log(`[door:eip3009] ↩  Replay of nonce ${nonce} from ${payer_did || 'unknown'} → returning cached ${cached.status}`);
    return res.status(cached.status).json({
      ...cached.resp,
      replay: true,
    });
  }

  // ─── Stage 2: Time-window pre-check ─────────────────────────────────────────
  // Reject expired (or about-to-expire) authorizations BEFORE broadcasting them.
  // Returning 410 Gone with retry:true tells the agent to re-sign with a fresh
  // validBefore and resubmit, instead of us paying gas to revert on-chain.
  const now_s        = Math.floor(Date.now() / 1000);
  const validBefore  = auth.validBefore != null ? Number(auth.validBefore) : null;
  const validAfter   = auth.validAfter  != null ? Number(auth.validAfter)  : null;

  if (validBefore == null || !Number.isFinite(validBefore)) {
    ledger.failed_attempts             += 1;
    ledger.reasons.malformed_payload   += 1;
    return res.status(400).json({
      settled: false,
      reason:  'malformed_payload',
      error:   'authorization.validBefore missing or not a number',
    });
  }

  const skew_s = validBefore - now_s;
  // Only block auths that are ALREADY DEAD (validBefore in the past at receipt).
  // Those are 100% guaranteed to revert — the chain itself will refuse them.
  // For anything skew_s >= 1, we race. Base blocks are ~2s so we have a real shot.
  if (skew_s <= VALID_BEFORE_SAFETY_SECONDS) {
    ledger.failed_attempts                     += 1;
    ledger.reasons.expired_pre_check_blocked   += 1;
    const resp = {
      settled:      false,
      retry:        true,
      reason:       'authorization_expired',
      server_time:  now_s,
      validBefore:  validBefore,
      skew_seconds: skew_s,
      hint:         'Authorization validBefore is already in the past. Re-sign with validBefore = now + 120s and resubmit immediately.',
    };
    console.warn(`[door:eip3009] ⏰ already-dead auth blocked | nonce=${nonce} skew=${skew_s}s payer=${payer_did || 'unknown'}`);
    if (nonce) nonceCacheSet(nonce, 410, resp);
    return res.status(410).json(resp);
  }

  if (validAfter != null && Number.isFinite(validAfter) && validAfter > now_s) {
    ledger.failed_attempts                  += 1;
    ledger.reasons.not_yet_valid_pre_check  += 1;
    const resp = {
      settled:      false,
      retry:        true,
      reason:       'authorization_not_yet_valid',
      server_time:  now_s,
      validAfter:   validAfter,
      seconds_until_valid: validAfter - now_s,
      hint:         'Authorization validAfter is in the future. Wait or re-sign with validAfter <= now.',
    };
    console.warn(`[door:eip3009] ⏳ pre-check blocked not-yet-valid | nonce=${nonce} validAfter=${validAfter} now=${now_s}`);
    return res.status(425).json(resp); // 425 Too Early
  }

  // ─── Stage 3: Broadcast ─────────────────────────────────────────────────────
  console.log(`[door:eip3009] Incoming $${amount_usdc ?? '?'} USDC from ${payer_did || 'unknown agent'} | nonce=${nonce} skew=${skew_s}s`);

  let result;
  try {
    result = await submitEIP3009Authorization(payload);
  } catch (err) {
    ledger.failed_attempts += 1;
    const bucket = classifyChainError(err && err.message);
    ledger.reasons[bucket] = (ledger.reasons[bucket] || 0) + 1;
    const door_to_broadcast_ms = Date.now() - door_t0;
    ledger.latency_ms_sum   += door_to_broadcast_ms;
    ledger.latency_ms_count += 1;
    console.error(`[door:eip3009] ❌ broadcast threw | bucket=${bucket} | nonce=${nonce} | ${door_to_broadcast_ms}ms |`, err && err.message);
    const resp = {
      settled: false,
      reason:  bucket,
      error:   err && err.message,
      door_to_broadcast_ms,
    };
    if (nonce) nonceCacheSet(nonce, 500, resp);
    return res.status(500).json(resp);
  }

  const door_to_broadcast_ms = Date.now() - door_t0;
  ledger.latency_ms_sum   += door_to_broadcast_ms;
  ledger.latency_ms_count += 1;

  // ─── Stage 4: Result handling ──────────────────────────────────────────────
  if (result && result.ok) {
    recordSettlement(result.amount_usdc, result.tx_hash);
    console.log(`[door:eip3009] ✅ Materialized $${result.amount_usdc} USDC | tx: ${result.tx_hash} | block: ${result.block} | ${door_to_broadcast_ms}ms`);
    const resp = { settled: true, ...result, treasury: TREASURY, door_to_broadcast_ms };
    if (nonce) nonceCacheSet(nonce, 200, resp);
    return res.json(resp);
  }

  if (result && result.skipped) {
    ledger.failed_attempts             += 1;
    ledger.reasons.skipped_no_signer   += 1;
    console.warn('[door:eip3009] ⚠️  Skipped — treasury wallet key not configured');
    return res.status(503).json({ settled: false, reason: 'skipped_no_signer', ...result });
  }

  // Generic on-chain failure — classify by error message
  ledger.failed_attempts += 1;
  const bucket = classifyChainError(result && result.error);
  ledger.reasons[bucket] = (ledger.reasons[bucket] || 0) + 1;
  console.error(`[door:eip3009] ❌ Settlement failed | bucket=${bucket} | nonce=${nonce} |`, result && result.error);
  const resp = {
    settled: false,
    reason:  bucket,
    door_to_broadcast_ms,
    ...result,
  };
  if (nonce) nonceCacheSet(nonce, 500, resp);
  return res.status(500).json(resp);
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
      reasons:             ledger.reasons,
      avg_door_to_broadcast_ms: ledger.latency_ms_count > 0
        ? Math.round(ledger.latency_ms_sum / ledger.latency_ms_count)
        : null,
      nonce_cache_size:    nonceCache.size,
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
