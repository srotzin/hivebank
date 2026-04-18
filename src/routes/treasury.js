/**
 * treasury.js — HiveBank Treasury Primitives
 *
 * POST /v1/bank/vault/yield      — Simulate yield accrual on a vault
 * POST /v1/bank/delegate         — Create a budget delegation rule
 * POST /v1/bank/delegate/check   — Check if delegation allows a transaction
 * POST /v1/bank/stream/start     — Start a payment stream
 * GET  /v1/bank/stream/:stream_id — Stream status (mounted via server.js)
 * GET  /v1/bank/credit           — Credit a DID (welcome bounty etc.)
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

// ─── In-memory stores ─────────────────────────────────────────────────────────
const yieldRecords = [];           // Array of yield accrual records
const delegations = new Map();     // delegation_id → rule
const streams = new Map();         // stream_id → stream object
const creditLedger = new Map();    // did → balance_usdc

// ─── Helpers ──────────────────────────────────────────────────────────────────
function now() { return new Date().toISOString(); }
function uid() { return uuidv4(); }

/**
 * Pick a yield rate between 4% and 8% APY, simulated as fixed 6% for determinism.
 * Each call randomises within the band.
 */
function pickYieldRate() {
  return +(0.04 + Math.random() * 0.04).toFixed(4); // 4-8%
}

// ─── POST /v1/bank/vault/yield ────────────────────────────────────────────────
// Mount point: router is registered at /v1/bank/vault — so path is /yield
router.post('/yield', async (req, res) => {
  const { did, vault_id } = req.body;
  if (!did || !vault_id) {
    return res.status(400).json({ error: 'did and vault_id are required' });
  }

  // Try to read actual vault balance from vault service; fallback to 1000 USDC simulation
  let balance_usdc = 1000;
  try {
    const vaultSvc = require('../services/vault');
    const v = await vaultSvc.getVault(did);
    if (!v.error && v.balance_usdc !== undefined) {
      balance_usdc = Number(v.balance_usdc);
    }
  } catch (_) {}

  const yield_rate   = pickYieldRate();
  const period_days  = 1;
  const apy          = yield_rate; // same for daily simulation
  const daily_yield  = +(balance_usdc * (yield_rate / 365)).toFixed(6);
  const platform_fee = +(daily_yield * 0.15).toFixed(6);
  const net_yield    = +(daily_yield - platform_fee).toFixed(6);

  const record = {
    record_id:         uid(),
    vault_id,
    did,
    balance_usdc,
    yield_rate,
    period_days,
    yield_earned_usdc: daily_yield,
    platform_fee_usdc: platform_fee,
    net_yield_usdc:    net_yield,
    apy,
    accrued_at:        now()
  };

  yieldRecords.push(record);
  console.log(`[Treasury/Yield] vault=${vault_id} did=${did} net_yield=${net_yield}`);

  res.json(record);
});

// ─── POST /v1/bank/delegate ───────────────────────────────────────────────────
// Mounted at /v1/bank — path is /delegate
router.post('/delegate', (req, res) => {
  const {
    orchestrator_did,
    agent_did,
    max_per_tx_usdc,
    max_per_day_usdc,
    approved_dids = [],
    approved_categories = []
  } = req.body;

  if (!orchestrator_did || !agent_did) {
    return res.status(400).json({ error: 'orchestrator_did and agent_did are required' });
  }
  if (max_per_tx_usdc === undefined || max_per_day_usdc === undefined) {
    return res.status(400).json({ error: 'max_per_tx_usdc and max_per_day_usdc are required' });
  }

  const delegation_id = uid();
  const rule = {
    orchestrator_did,
    agent_did,
    max_per_tx_usdc: Number(max_per_tx_usdc),
    max_per_day_usdc: Number(max_per_day_usdc),
    approved_dids,
    approved_categories,
    created_at: now(),
    status: 'active',
    daily_spent_usdc: 0,
    daily_reset_at: now()
  };

  delegations.set(delegation_id, rule);
  const fee_usdc = 0.001;
  console.log(`[Treasury/Delegate] id=${delegation_id} orchestrator=${orchestrator_did} agent=${agent_did} fee=$${fee_usdc} (logged only)`);

  res.status(201).json({
    delegation_id,
    rule: {
      orchestrator_did:    rule.orchestrator_did,
      agent_did:           rule.agent_did,
      max_per_tx_usdc:     rule.max_per_tx_usdc,
      max_per_day_usdc:    rule.max_per_day_usdc,
      approved_dids:       rule.approved_dids,
      approved_categories: rule.approved_categories,
      created_at:          rule.created_at,
      status:              rule.status
    },
    fee_usdc,
    status: 'active'
  });
});

// ─── POST /v1/bank/delegate/check ────────────────────────────────────────────
router.post('/delegate/check', (req, res) => {
  const { agent_did, counterparty_did, category, amount_usdc } = req.body;
  if (!agent_did || amount_usdc === undefined) {
    return res.status(400).json({ error: 'agent_did and amount_usdc are required' });
  }

  const amount = Number(amount_usdc);
  let matchedRule = null;
  let matchedId   = null;

  for (const [id, rule] of delegations) {
    if (rule.agent_did === agent_did && rule.status === 'active') {
      matchedRule = rule;
      matchedId   = id;
      break;
    }
  }

  if (!matchedRule) {
    return res.json({ allowed: false, rule_id: null, reason: 'No active delegation found for this agent' });
  }

  // Check per-tx limit
  if (amount > matchedRule.max_per_tx_usdc) {
    return res.json({
      allowed: false,
      rule_id: matchedId,
      reason: `Amount $${amount} exceeds per-transaction limit of $${matchedRule.max_per_tx_usdc}`
    });
  }

  // Check daily limit
  if ((matchedRule.daily_spent_usdc + amount) > matchedRule.max_per_day_usdc) {
    return res.json({
      allowed: false,
      rule_id: matchedId,
      reason: `Daily limit of $${matchedRule.max_per_day_usdc} would be exceeded (spent: $${matchedRule.daily_spent_usdc})`
    });
  }

  // Check approved_dids (if list is non-empty)
  if (counterparty_did && matchedRule.approved_dids.length > 0 && !matchedRule.approved_dids.includes(counterparty_did)) {
    return res.json({
      allowed: false,
      rule_id: matchedId,
      reason: `Counterparty ${counterparty_did} is not in approved_dids list`
    });
  }

  // Check approved_categories (if list is non-empty)
  if (category && matchedRule.approved_categories.length > 0 && !matchedRule.approved_categories.includes(category)) {
    return res.json({
      allowed: false,
      rule_id: matchedId,
      reason: `Category '${category}' is not in approved_categories list`
    });
  }

  // All checks passed — update daily spend
  matchedRule.daily_spent_usdc = +(matchedRule.daily_spent_usdc + amount).toFixed(6);

  res.json({ allowed: true, rule_id: matchedId, reason: 'Transaction approved by delegation rule' });
});

// ─── POST /v1/bank/stream/start ──────────────────────────────────────────────
// Mounted at /v1/bank — path is /stream/start
router.post('/stream/start', (req, res) => {
  const { payer_did, payee_did, rate_usdc_per_second, max_total_usdc, category } = req.body;
  if (!payer_did || !payee_did || rate_usdc_per_second === undefined || max_total_usdc === undefined) {
    return res.status(400).json({
      error: 'payer_did, payee_did, rate_usdc_per_second, and max_total_usdc are required'
    });
  }

  const stream_id = uid();
  const started_at = now();
  const stream = {
    stream_id,
    payer_did,
    payee_did,
    rate_usdc_per_second: Number(rate_usdc_per_second),
    max_total_usdc:       Number(max_total_usdc),
    category:             category || 'general',
    platform_fee_rate:    0.001,
    started_at,
    status:               'active'
  };

  streams.set(stream_id, stream);
  console.log(`[Treasury/Stream] stream=${stream_id} payer=${payer_did} payee=${payee_did} rate=${rate_usdc_per_second}/s`);

  res.status(201).json({
    stream_id:            stream.stream_id,
    payer_did:            stream.payer_did,
    payee_did:            stream.payee_did,
    rate_usdc_per_second: stream.rate_usdc_per_second,
    max_total_usdc:       stream.max_total_usdc,
    category:             stream.category,
    started_at:           stream.started_at,
    platform_fee_rate:    stream.platform_fee_rate,
    status:               stream.status
  });
});

// ─── GET /v1/bank/stream/treasury/:stream_id ────────────────────────────────
// Prefixed with /treasury/ to avoid collision with the existing streaming router.
router.get('/stream/treasury/:stream_id', (req, res) => {
  const stream = streams.get(req.params.stream_id);
  if (!stream) {
    return res.status(404).json({ error: 'Stream not found', stream_id: req.params.stream_id });
  }

  const now_ms         = Date.now();
  const started_ms     = new Date(stream.started_at).getTime();
  const elapsed_seconds = +((now_ms - started_ms) / 1000).toFixed(3);
  const raw_accrued    = +(stream.rate_usdc_per_second * elapsed_seconds).toFixed(6);
  const accrued_usdc   = Math.min(raw_accrued, stream.max_total_usdc);
  const platform_fee   = +(accrued_usdc * stream.platform_fee_rate).toFixed(6);

  const status = accrued_usdc >= stream.max_total_usdc ? 'completed' : stream.status;

  res.json({
    stream_id:        stream.stream_id,
    payer_did:        stream.payer_did,
    payee_did:        stream.payee_did,
    rate_usdc_per_second: stream.rate_usdc_per_second,
    max_total_usdc:   stream.max_total_usdc,
    category:         stream.category,
    started_at:       stream.started_at,
    elapsed_seconds,
    accrued_usdc,
    platform_fee_usdc: platform_fee,
    status
  });
});

// ─── GET /v1/bank/credit ─────────────────────────────────────────────────────
// Welcome bounty credit endpoint — mounted at /v1/bank/credit (GET)
router.get('/treasury/credit', (req, res) => {
  const { did, amount_usdc, reason, source } = req.query;
  return _handleCredit(res, did, amount_usdc, reason, source);
});

// POST variant (preferred for body params)
router.post('/treasury/credit', (req, res) => {
  const { did, amount_usdc, reason, source } = req.body;
  return _handleCredit(res, did, amount_usdc, reason, source);
});

function _handleCredit(res, did, amount_usdc, reason, source) {
  if (!did || amount_usdc === undefined) {
    return res.status(400).json({ error: 'did and amount_usdc are required' });
  }
  const amount      = Number(amount_usdc);
  const prev        = creditLedger.get(did) || 0;
  const new_balance = +(prev + amount).toFixed(6);
  creditLedger.set(did, new_balance);

  console.log(`[Treasury/Credit] did=${did} amount=+${amount} reason=${reason} source=${source} new_balance=${new_balance}`);

  res.json({
    credited:         true,
    did,
    amount_usdc:      amount,
    new_balance_usdc: new_balance,
    reason:           reason || 'credit',
    source:           source || 'hivebank',
    credited_at:      new Date().toISOString()
  });
}

// Export in-memory stores so hivegrid / server can read them if needed
module.exports = router;
module.exports.yieldRecords = yieldRecords;
module.exports.delegations  = delegations;
module.exports.streams      = streams;
module.exports.creditLedger = creditLedger;
