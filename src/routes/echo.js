'use strict';
// Merged from hiveecho — temporal state recording, Merkle proofs, anchoring
// Mounted at /v1/echo in server.js
const express = require('express');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

// ─── In-memory temporal engine (ported from hiveecho/src/services/temporal-engine.js) ──

const stateLog      = [];
const currentStates = new Map();
const merkleBlocks  = [];
const contractAnchors = new Map();

let globalBlockNumber = 0;
const BLOCK_SIZE      = 1000;
let pendingLeaves     = [];

const echoStats = {
  statesRecorded:    0,
  proofsGenerated:   0,
  anchorsMade:       0,
  contractsAnchored: 0,
  platformsTracked:  new Set(),
};

const VALID_PLATFORMS    = ['hivetrust','hivemind','hiveforge','hivelaw','simpson','hivebank'];
const VALID_ENTITY_TYPES = ['agent','transaction','dispute','memory','bounty','reputation','delegation','lease'];

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildMerkleRoot(leafHashes) {
  if (leafHashes.length === 0) return sha256('empty');
  if (leafHashes.length === 1) return leafHashes[0];
  const nextLevel = [];
  for (let i = 0; i < leafHashes.length; i += 2) {
    const left  = leafHashes[i];
    const right = leafHashes[i + 1] || left;
    nextLevel.push(sha256(left + right));
  }
  return buildMerkleRoot(nextLevel);
}

function generateMerkleProof(leafHashes, targetIndex) {
  const proof = [];
  let index = targetIndex;
  let level = [...leafHashes];
  while (level.length > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = level[Math.min(siblingIndex, level.length - 1)];
    proof.push({ hash: sibling, position: index % 2 === 0 ? 'right' : 'left' });
    const nextLevel = [];
    for (let i = 0; i < level.length; i += 2) {
      const left  = level[i];
      const right = level[i + 1] || left;
      nextLevel.push(sha256(left + right));
    }
    level = nextLevel;
    index = Math.floor(index / 2);
  }
  return { root: level[0], path: proof };
}

function computeStateHash(entityId, state, prevHash, timestamp) {
  return sha256(entityId + JSON.stringify(state) + prevHash + timestamp);
}

function finalizeBlock(force = false) {
  if (pendingLeaves.length === 0) return null;
  if (!force && pendingLeaves.length < BLOCK_SIZE) return null;
  globalBlockNumber++;
  const rootHash = buildMerkleRoot(pendingLeaves);
  const now      = new Date().toISOString();
  const block    = { block_number: globalBlockNumber, root_hash: rootHash, event_count: pendingLeaves.length, leaf_hashes: [...pendingLeaves], anchored: false, anchor_tx_hash: null, simulated: false, created_at: now };
  merkleBlocks.push(block);
  pendingLeaves = [];
  return block;
}

function recordState({ platform, entity_type, entity_id, state, previous_state_hash }) {
  const key      = `${platform}:${entity_id}`;
  const existing = currentStates.get(key);
  const prevHash = previous_state_hash || (existing ? existing.state_hash : sha256('genesis'));
  const now      = new Date().toISOString();
  const stateHash = computeStateHash(entity_id, state, prevHash, now);
  const entry    = { id: uuidv4(), platform, entity_type, entity_id, state, state_hash: stateHash, prev_hash: prevHash, block_number: globalBlockNumber + 1, recorded_at: now };
  stateLog.push(entry);
  currentStates.set(key, entry);
  pendingLeaves.push(stateHash);
  echoStats.statesRecorded++;
  echoStats.platformsTracked.add(platform);
  if (pendingLeaves.length >= BLOCK_SIZE) finalizeBlock(true);
  return entry;
}

function getState(platform, entityId, atTimestamp) {
  const key = `${platform}:${entityId}`;
  if (!atTimestamp) {
    const current = currentStates.get(key);
    if (!current) return null;
    return { ...current, is_historical: false };
  }
  const at = new Date(atTimestamp).getTime();
  const matches = stateLog.filter(e => e.platform === platform && e.entity_id === entityId && new Date(e.recorded_at).getTime() <= at);
  if (matches.length === 0) return null;
  return { ...matches[matches.length - 1], is_historical: true };
}

function getHistory(platform, entityId, { from, to, limit = 100 } = {}) {
  let entries = stateLog.filter(e => e.platform === platform && e.entity_id === entityId);
  if (from) { const fromMs = new Date(from).getTime(); entries = entries.filter(e => new Date(e.recorded_at).getTime() >= fromMs); }
  if (to)   { const toMs   = new Date(to).getTime();   entries = entries.filter(e => new Date(e.recorded_at).getTime() <= toMs);   }
  return entries.slice(0, limit);
}

function generateProof(platform, entityId, timestamp, stateHash) {
  const entry = stateLog.find(e => e.platform === platform && e.entity_id === entityId && e.state_hash === stateHash);
  if (!entry) return null;
  for (const block of merkleBlocks) {
    const idx = block.leaf_hashes.indexOf(stateHash);
    if (idx !== -1) {
      const proof = generateMerkleProof(block.leaf_hashes, idx);
      echoStats.proofsGenerated++;
      return { proof: { root_hash: proof.root, path: proof.path, leaf_hash: stateHash }, block_number: block.block_number, anchored: block.anchored, anchor_tx_hash: block.anchor_tx_hash, simulated: block.simulated };
    }
  }
  const pendingIdx = pendingLeaves.indexOf(stateHash);
  if (pendingIdx !== -1) {
    const proof = generateMerkleProof(pendingLeaves, pendingIdx);
    echoStats.proofsGenerated++;
    return { proof: { root_hash: proof.root, path: proof.path, leaf_hash: stateHash }, block_number: globalBlockNumber + 1, anchored: false, anchor_tx_hash: null, simulated: false };
  }
  return null;
}

function anchorRoot(force = false) {
  let block = finalizeBlock(force);
  if (!block) block = merkleBlocks.filter(b => !b.anchored).pop();
  if (!block) return null;
  const now = new Date().toISOString();
  const simulatedTxHash = `0xsim_${sha256(block.root_hash + now)}`;
  block.anchored = true;
  block.anchor_tx_hash = simulatedTxHash;
  block.simulated  = true;
  block.anchored_at = now;
  echoStats.anchorsMade++;
  return { root_hash: block.root_hash, event_count: block.event_count, anchor_tx_hash: simulatedTxHash, anchored_at: now, simulated: true, block_number: block.block_number };
}

function anchorContract({ contract_id, parties, terms_hash, value_usdc, platform_states }) {
  const anchorId = uuidv4();
  const now = new Date().toISOString();
  const allPartyStates = {};
  for (const did of parties) {
    allPartyStates[did] = {};
    for (const [key, entry] of currentStates.entries()) {
      if (entry.state && entry.state.did === did) allPartyStates[did][key] = { state: entry.state, state_hash: entry.state_hash, recorded_at: entry.recorded_at };
    }
  }
  const contractData = JSON.stringify({ contract_id, parties, terms_hash, value_usdc, platform_states, all_party_states: allPartyStates, anchored_at: now });
  const contractHash = sha256(contractData);
  const stateRoot    = buildMerkleRoot(Object.values(allPartyStates).flatMap(p => Object.values(p)).map(s => s.state_hash || sha256(JSON.stringify(s))));
  const anchor       = { anchor_id: anchorId, contract_id, contract_hash: contractHash, state_root: stateRoot, parties, terms_hash, value_usdc, platform_states, all_party_states: allPartyStates, anchored_at: now };
  contractAnchors.set(anchorId, anchor);
  echoStats.contractsAnchored++;
  return anchor;
}

function getRoots({ anchored, limit = 50 } = {}) {
  let roots = [...merkleBlocks];
  if (anchored !== undefined) roots = roots.filter(b => b.anchored === anchored);
  return roots.slice(-limit).map(b => ({ block_number: b.block_number, root_hash: b.root_hash, event_count: b.event_count, anchored: b.anchored, anchor_tx_hash: b.anchor_tx_hash, simulated: b.simulated, created_at: b.created_at, anchored_at: b.anchored_at || null }));
}

function getEchoStats() {
  return { states_recorded: echoStats.statesRecorded, proofs_generated: echoStats.proofsGenerated, anchors_made: echoStats.anchorsMade, contracts_anchored: echoStats.contractsAnchored, platforms_tracked: [...echoStats.platformsTracked], total_blocks: merkleBlocks.length, pending_events: pendingLeaves.length, block_size: BLOCK_SIZE };
}

// ─── Auth helpers (matching hiveecho pattern — adapted for HiveBank middleware) ──

function requireDID(req, res, next) {
  const did = req.headers['x-did'] || req.headers['x-hive-did'] || req.headers['x-hivetrust-did'] || req.agentDid;
  if (!did) return res.status(401).json({ error: 'Authentication required', message: 'Missing DID. Provide x-did or x-hive-did header.' });
  req.did = did;
  next();
}

function requireInternal(req, res, next) {
  const internalKey  = req.headers['x-internal-key'] || req.headers['x-hive-internal'];
  const expectedKey  = process.env.HIVE_INTERNAL_KEY || process.env.INTERNAL_KEY;
  if (!expectedKey || internalKey !== expectedKey) return res.status(403).json({ error: 'Forbidden', message: 'Internal key required. Only Hive services may push state.' });
  next();
}

function requireAdmin(req, res, next) {
  const adminKey    = req.headers['x-admin-key'];
  const expectedKey = process.env.ADMIN_KEY || 'hive-admin-key';
  if (adminKey !== expectedKey) return res.status(403).json({ error: 'Forbidden', message: 'Admin key required for this operation' });
  next();
}

const HISTORICAL_QUERY_PRICE = 0.10;
const CONTRACT_ANCHOR_PRICE  = 1.00;

function requirePayment(price) {
  return (req, res, next) => {
    if (price === 0) return next();
    const internalKey  = req.headers['x-hive-internal'];
    const expectedKey  = process.env.HIVE_INTERNAL_KEY;
    if (expectedKey && internalKey === expectedKey) return next();
    const payment = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!payment) {
      return res.status(402).json({
        error: 'payment_required',
        x402: { version: '1.0', amount_usdc: price, description: 'HiveEcho temporal query', payment_methods: ['x402-usdc'], network: 'base' },
      });
    }
    next();
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /v1/echo/record-state
router.post('/record-state', requireDID, requireInternal, requirePayment(0), (req, res) => {
  const { platform, entity_type, entity_id, state, previous_state_hash } = req.body;
  if (!platform || !entity_type || !entity_id || !state) {
    return res.status(400).json({ error: 'Missing required fields: platform, entity_type, entity_id, state' });
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({ error: `Invalid platform. Must be one of: ${VALID_PLATFORMS.join(', ')}` });
  }
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: `Invalid entity_type. Must be one of: ${VALID_ENTITY_TYPES.join(', ')}` });
  }
  const entry = recordState({ platform, entity_type, entity_id, state, previous_state_hash });
  res.status(201).json({ success: true, state_entry: entry });
});

// GET /v1/echo/state/:platform/:entity_id
router.get('/state/:platform/:entity_id', requireDID, requirePayment(HISTORICAL_QUERY_PRICE), (req, res) => {
  const { platform, entity_id } = req.params;
  const { at } = req.query;
  const result = getState(platform, entity_id, at);
  if (!result) return res.status(404).json({ error: 'State not found', platform, entity_id });
  res.json(result);
});

// GET /v1/echo/history/:platform/:entity_id
router.get('/history/:platform/:entity_id', requireDID, requirePayment(0.10), (req, res) => {
  const { platform, entity_id } = req.params;
  const { from, to, limit } = req.query;
  const entries = getHistory(platform, entity_id, { from, to, limit: limit ? parseInt(limit, 10) : 100 });
  res.json({ platform, entity_id, count: entries.length, entries });
});

// POST /v1/echo/prove
router.post('/prove', requireDID, requirePayment(0.25), (req, res) => {
  const { platform, entity_id, timestamp, state_hash } = req.body;
  if (!platform || !entity_id || !state_hash) {
    return res.status(400).json({ error: 'Missing required fields: platform, entity_id, state_hash' });
  }
  const result = generateProof(platform, entity_id, timestamp, state_hash);
  if (!result) return res.status(404).json({ error: 'Proof not found', message: 'No matching state found for the given parameters' });
  res.json(result);
});

// POST /v1/echo/anchor
router.post('/anchor', requireDID, requireAdmin, requirePayment(0.50), (req, res) => {
  const { force } = req.body || {};
  const result = anchorRoot(!!force);
  if (!result) return res.status(404).json({ error: 'Nothing to anchor', message: 'No unanchored blocks available. Record more states or use force=true.' });
  res.json({ success: true, ...result });
});

// POST /v1/echo/anchor-contract
router.post('/anchor-contract', requireDID, requirePayment(CONTRACT_ANCHOR_PRICE), (req, res) => {
  const { contract_id, parties, terms_hash, value_usdc, platform_states } = req.body;
  if (!contract_id || !parties || !terms_hash || value_usdc === undefined) {
    return res.status(400).json({ error: 'Missing required fields: contract_id, parties, terms_hash, value_usdc' });
  }
  if (!Array.isArray(parties) || parties.length < 2) {
    return res.status(400).json({ error: 'parties must be an array with at least 2 DIDs' });
  }
  const anchor = anchorContract({ contract_id, parties, terms_hash, value_usdc, platform_states });
  res.status(201).json({ success: true, ...anchor });
});

// GET /v1/echo/roots
router.get('/roots', requireDID, requirePayment(0), (req, res) => {
  const { anchored, limit } = req.query;
  const roots = getRoots({ anchored: anchored !== undefined ? anchored === 'true' : undefined, limit: limit ? parseInt(limit, 10) : 50 });
  res.json({ count: roots.length, roots });
});

// GET /v1/echo/stats
router.get('/stats', requireDID, requirePayment(0), (req, res) => {
  res.json(getEchoStats());
});

module.exports = router;
