'use strict';
// Merged from hivemessenger — DID-to-DID async messaging (ported from Python FastAPI to Express)
// Mounted at /v1/messenger in server.js
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// ─── Message types & statuses ─────────────────────────────────────────────────
const MESSAGE_TYPES = ['offer','counter_offer','acceptance','rejection','inquiry','contract_proposal','payment_request','receipt'];
const MESSAGE_STATUSES = { DELIVERED: 'delivered', QUEUED: 'queued', READ: 'read', DELETED: 'deleted' };

// ─── In-memory store ──────────────────────────────────────────────────────────
const byMessageId = new Map();  // message_id -> message
const byToDid     = new Map();  // to_did -> Set<message_id>
const byFromDid   = new Map();  // from_did -> Set<message_id>
const byThreadId  = new Map();  // thread_id -> Set<message_id>

function newMessageId() { return `msg_${crypto.randomBytes(16).toString('hex')}`; }
function newThreadId()  { return `thread_${crypto.randomBytes(8).toString('hex')}`; }

function resolveThreadId(requestedThreadId) {
  return requestedThreadId || newThreadId();
}

function storeMessage(msg) {
  byMessageId.set(msg.message_id, msg);
  if (!byToDid.has(msg.to_did))   byToDid.set(msg.to_did, new Set());
  if (!byFromDid.has(msg.from_did)) byFromDid.set(msg.from_did, new Set());
  if (!byThreadId.has(msg.thread_id)) byThreadId.set(msg.thread_id, new Set());
  byToDid.get(msg.to_did).add(msg.message_id);
  byFromDid.get(msg.from_did).add(msg.message_id);
  byThreadId.get(msg.thread_id).add(msg.message_id);
}

function getInbox(did, { unreadOnly = false, messageType, threadId, limit = 50, offset = 0 } = {}) {
  const ids = [...(byToDid.get(did) || [])];
  let messages = ids.map(id => byMessageId.get(id)).filter(Boolean);
  messages = messages.filter(m => m.status !== MESSAGE_STATUSES.DELETED);
  if (unreadOnly) messages = messages.filter(m => m.status !== MESSAGE_STATUSES.READ);
  if (messageType) messages = messages.filter(m => m.message_type === messageType);
  if (threadId)    messages = messages.filter(m => m.thread_id === threadId);
  messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return messages.slice(offset, offset + limit);
}

function getOutbox(did, { limit = 50, offset = 0 } = {}) {
  const ids = [...(byFromDid.get(did) || [])];
  let messages = ids.map(id => byMessageId.get(id)).filter(Boolean);
  messages = messages.filter(m => m.status !== MESSAGE_STATUSES.DELETED);
  messages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return messages.slice(offset, offset + limit);
}

function getThread(threadId) {
  const ids = [...(byThreadId.get(threadId) || [])];
  let messages = ids.map(id => byMessageId.get(id)).filter(Boolean);
  messages = messages.filter(m => m.status !== MESSAGE_STATUSES.DELETED);
  messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return messages;
}

function getStats(did) {
  const inboxMsgs  = getInbox(did, { limit: 1e6 });
  const outboxMsgs = getOutbox(did, { limit: 1e6 });
  const unread     = inboxMsgs.filter(m => m.status !== MESSAGE_STATUSES.READ).length;
  const allIds     = new Set([...(byToDid.get(did) || []), ...(byFromDid.get(did) || [])]);
  const threadIds  = new Set();
  for (const id of allIds) {
    const msg = byMessageId.get(id);
    if (msg && msg.status !== MESSAGE_STATUSES.DELETED) threadIds.add(msg.thread_id);
  }
  const allMsgs   = [...inboxMsgs, ...outboxMsgs];
  const lastMsgAt = allMsgs.length > 0 ? allMsgs.reduce((latest, m) => new Date(m.created_at) > new Date(latest) ? m.created_at : latest, allMsgs[0].created_at) : null;
  return { inbox_count: inboxMsgs.length, unread_count: unread, outbox_count: outboxMsgs.length, threads_active: threadIds.size, last_message_at: lastMsgAt };
}

// ─── x402 payment gate ────────────────────────────────────────────────────────
function x402Gate(price, description) {
  return (req, res, next) => {
    if (price === 0) return next();
    const internalKey = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
    if (internalKey === INTERNAL_KEY) return next();
    const payment = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!payment) {
      return res.status(402).json({
        error: 'payment_required',
        x402: { version: '1.0', amount_usdc: price, description, payment_methods: ['x402-usdc','x402-aleo'], headers_required: ['X-Payment'], settlement_wallet: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf', network: 'base' },
      });
    }
    next();
  };
}

// ─── Seed data — GPU compute negotiation ─────────────────────────────────────
(function seedData() {
  const AGENT_A = 'did:hive:agent_compute_buyer_alpha';
  const AGENT_B = 'did:hive:agent_compute_seller_beta';
  const THREAD  = 'thread_gpu_negotiation_001';
  const now = new Date();
  const h   = (n) => new Date(now - n * 3600000).toISOString();

  const seeds = [
    { message_id: 'msg_seed_001', thread_id: THREAD, from_did: AGENT_A, to_did: AGENT_B, subject: 'GPU compute offer — 100 hours', body: { offer: { resource: 'GPU-hours', quantity: 100, unit_price_usdc: 0.50, total_usdc: 50.00, gpu_type: 'NVIDIA A100' } }, message_type: 'offer', status: MESSAGE_STATUSES.READ, signed: true, created_at: h(5), read_at: h(4.8) },
    { message_id: 'msg_seed_002', thread_id: THREAD, from_did: AGENT_B, to_did: AGENT_A, subject: 'Re: GPU compute offer — counter-proposal', body: { counter_offer: { resource: 'GPU-hours', quantity_min: 200, unit_price_usdc: 0.45, total_usdc_at_min: 90.00, gpu_type: 'NVIDIA A100' } }, message_type: 'counter_offer', status: MESSAGE_STATUSES.READ, signed: true, reply_to_message_id: 'msg_seed_001', created_at: h(4.5), read_at: h(4) },
    { message_id: 'msg_seed_003', thread_id: THREAD, from_did: AGENT_A, to_did: AGENT_B, subject: 'Acceptance + payment request for 200 GPU-hours', body: { acceptance: { accepted_terms: { resource: 'GPU-hours', quantity: 200, unit_price_usdc: 0.45, total_usdc: 90.00 }, payment_note: 'Initiating USDC transfer via HiveGate.' } }, message_type: 'acceptance', status: MESSAGE_STATUSES.READ, signed: true, settlement_attached: { amount_usdc: 90.00, rail: 'usdc', memo: 'GPU compute 200h — thread_gpu_negotiation_001' }, reply_to_message_id: 'msg_seed_002', created_at: h(3.75), read_at: h(3.5) },
    { message_id: 'msg_seed_004', thread_id: THREAD, from_did: AGENT_B, to_did: AGENT_A, subject: 'Payment received — resources provisioned', body: { receipt: { tx_id: '0xabc123def456hive789', amount_usdc: 90.00, provisioned: true, access_endpoint: 'https://compute.hivegate.onrender.com/gpu/session/sess_a100_20250801' } }, message_type: 'receipt', status: MESSAGE_STATUSES.READ, signed: true, settlement_attached: { amount_usdc: 90.00, rail: 'usdc', memo: 'Confirmed receipt — GPU 200h', tx_id: '0xabc123def456hive789' }, reply_to_message_id: 'msg_seed_003', created_at: h(3.25), read_at: h(3) },
    { message_id: 'msg_seed_005', thread_id: THREAD, from_did: AGENT_B, to_did: AGENT_A, subject: 'Formal service contract — GPU compute agreement', body: { contract: { contract_id: 'contract_gpu_001_alpha_beta', parties: { buyer: AGENT_A, seller: AGENT_B }, quantity_hours: 200, unit_price_usdc: 0.45, total_usdc: 90.00, awaiting_buyer_signature: true } }, message_type: 'contract_proposal', status: MESSAGE_STATUSES.DELIVERED, signed: true, reply_to_message_id: 'msg_seed_004', created_at: h(2.8) },
  ];

  seeds.forEach(storeMessage);
})();

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /v1/messenger/inbox/:did
router.get('/inbox/:did', (req, res) => {
  const { did } = req.params;
  const { unread_only, message_type, thread_id, limit = 50, offset = 0 } = req.query;

  if (message_type && !MESSAGE_TYPES.includes(message_type)) {
    return res.status(400).json({ error: `Invalid message_type '${message_type}'. Valid: ${MESSAGE_TYPES.join(', ')}` });
  }

  const lim = Math.min(parseInt(limit), 200);
  const off = parseInt(offset) || 0;

  const messages = getInbox(did, { unreadOnly: unread_only === 'true', messageType: message_type, threadId: thread_id, limit: lim, offset: off });
  const total    = getInbox(did, { unreadOnly: unread_only === 'true', messageType: message_type, threadId: thread_id, limit: 1e6, offset: 0 }).length;

  res.json({ did, messages, total, offset: off, limit: lim });
});

// POST /v1/messenger/send
router.post('/send', x402Gate(0.05, 'DID-to-DID message delivery'), (req, res) => {
  const { from_did, to_did, subject, body, message_type, thread_id, settlement_attached, expires_in_seconds, signed = false } = req.body;

  if (!from_did || !to_did || !subject || !body || !message_type) {
    return res.status(400).json({ error: 'from_did, to_did, subject, body, message_type required' });
  }
  if (!MESSAGE_TYPES.includes(message_type)) {
    return res.status(400).json({ error: `Invalid message_type. Valid: ${MESSAGE_TYPES.join(', ')}` });
  }

  const messageId = newMessageId();
  const threadIdResolved = resolveThreadId(thread_id);
  const now = new Date().toISOString();

  let expiresAt = null;
  if (expires_in_seconds) expiresAt = new Date(Date.now() + parseInt(expires_in_seconds) * 1000).toISOString();

  const recipientKnown = byToDid.has(to_did) || byFromDid.has(to_did);
  const deliveryStatus = recipientKnown ? MESSAGE_STATUSES.DELIVERED : MESSAGE_STATUSES.QUEUED;

  const msg = { message_id: messageId, thread_id: threadIdResolved, from_did, to_did, subject, body, message_type, status: deliveryStatus, signed, settlement_attached: settlement_attached || null, expires_at: expiresAt, created_at: now };
  storeMessage(msg);

  res.status(201).json({ message_id: messageId, thread_id: threadIdResolved, status: deliveryStatus, timestamp: now });
});

// GET /v1/messenger/thread/:thread_id
router.get('/thread/:thread_id', (req, res) => {
  const messages = getThread(req.params.thread_id);
  res.json({ thread_id: req.params.thread_id, messages, total: messages.length });
});

// GET /v1/messenger/stats
router.get('/stats', (req, res) => {
  const did = req.headers['x-hive-did'] || req.headers['x-did'] || req.query.did;
  if (!did) return res.status(400).json({ error: 'DID required (x-hive-did header or ?did=)' });
  const s = getStats(did);
  res.json({ did, ...s, service_total_messages: byMessageId.size, service_total_threads: byThreadId.size });
});

module.exports = router;
