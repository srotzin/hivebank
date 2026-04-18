/**
 * hivegrid.js — HiveGrid Multi-Rail Payment Routing
 *
 * Protocol-neutral payment routing across 4 settlement rails.
 * All simulation in-memory — real on-chain routing is Phase 2.
 *
 * POST /v1/grid/route    — Select optimal rail for a payment
 * POST /v1/grid/execute  — Execute a pending route
 * GET  /v1/grid/rails    — List all available rails
 * GET  /v1/grid/stats    — Aggregate routing statistics
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');

// ─── Rail definitions ─────────────────────────────────────────────────────────
const RAILS = {
  usdc_base_l2: {
    id:               'usdc_base_l2',
    name:             'USDC Base L2',
    description:      'Circle USDC on Base L2 — EVM-compatible, fast finality, transparent on-chain.',
    currency:         'USDC',
    network:          'Base L2',
    fee_pct:          0.0005,   // 0.05%
    speed:            'fast',
    finality_seconds: 2,
    compliance:       'high',
    zk_private:       false
  },
  usdcx_aleo_zk: {
    id:               'usdcx_aleo_zk',
    name:             'USDCx Aleo ZK',
    description:      'Circle-backed USDCx on Aleo mainnet — ZK proofs hide amounts, sender/receiver visible.',
    currency:         'USDCx',
    network:          'Aleo',
    fee_pct:          0.0008,   // 0.08%
    speed:            'medium',
    finality_seconds: 30,
    compliance:       'very_high',
    zk_private:       true,
    zk_mode:          'amounts'
  },
  usad_aleo_zk: {
    id:               'usad_aleo_zk',
    name:             'USAD Aleo ZK',
    description:      'Paxos USAD on Aleo mainnet — ZK proofs hide amounts AND addresses (full stealth mode).',
    currency:         'USAD',
    network:          'Aleo',
    fee_pct:          0.0006,   // 0.06%
    speed:            'medium',
    finality_seconds: 30,
    compliance:       'very_high',
    zk_private:       true,
    zk_mode:          'full_stealth'
  },
  aleo_native: {
    id:               'aleo_native',
    name:             'ALEO Native',
    description:      'Native ALEO token on Aleo mainnet — pure ZK, lowest fees, medium compliance.',
    currency:         'ALEO',
    network:          'Aleo',
    fee_pct:          0.0003,   // 0.03%
    speed:            'medium',
    finality_seconds: 30,
    compliance:       'medium',
    zk_private:       true,
    zk_mode:          'native_zk'
  }
};

const HIVE_ROUTING_FEE_PCT = 0.0005; // 0.05% HiveGrid routing fee

// ─── In-memory stores ─────────────────────────────────────────────────────────
const pendingRoutes = new Map();   // route_id → route object
const executedTxs   = new Map();   // tx_id    → tx object
const stats = {
  total_routed_usdc:    0,
  tx_count:             0,
  rail_distribution:    { usdc_base_l2: 0, usdcx_aleo_zk: 0, usad_aleo_zk: 0, aleo_native: 0 },
  total_hive_fees_usdc: 0
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uid()  { return uuidv4(); }
function now()  { return new Date().toISOString(); }

function arrivalTime(rail) {
  const s = rail.finality_seconds;
  const eta = new Date(Date.now() + s * 1000);
  return eta.toISOString();
}

function mockTxHash() {
  return '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

/**
 * Select rail based on priority.
 */
function selectRail(priority) {
  switch (priority) {
    case 'cheapest':
      return Object.values(RAILS).sort((a, b) => a.fee_pct - b.fee_pct)[0];
    case 'fastest':
      return RAILS.usdc_base_l2; // always fastest
    case 'most_compliant':
      // ZK rails with very_high compliance; prefer USDCx (amounts hidden)
      return RAILS.usdcx_aleo_zk;
    default:
      return RAILS.usdc_base_l2; // default: fast
  }
}

// ─── POST /v1/grid/route ─────────────────────────────────────────────────────
router.post('/route', (req, res) => {
  const { from_did, to_did, amount_usd, priority = 'cheapest' } = req.body;

  if (!from_did || !to_did || amount_usd === undefined) {
    return res.status(400).json({ error: 'from_did, to_did, and amount_usd are required' });
  }

  const validPriorities = ['cheapest', 'fastest', 'most_compliant'];
  if (!validPriorities.includes(priority)) {
    return res.status(400).json({ error: `priority must be one of: ${validPriorities.join(', ')}` });
  }

  const amount        = Number(amount_usd);
  const rail          = selectRail(priority);
  const fee_usdc      = +(amount * rail.fee_pct).toFixed(6);
  const hive_fee      = +(amount * HIVE_ROUTING_FEE_PCT).toFixed(6);
  const total_cost    = +(fee_usdc + hive_fee).toFixed(6);
  const route_id      = uid();

  const route = {
    route_id,
    from_did,
    to_did,
    amount_usd:              amount,
    priority,
    selected_rail:           rail.id,
    rail_name:               rail.name,
    fee_usdc,
    fee_pct:                 rail.fee_pct,
    estimated_arrival:       arrivalTime(rail),
    compliance_level:        rail.compliance,
    zk_private:              rail.zk_private,
    hive_routing_fee_usdc:   hive_fee,
    total_cost_usdc:         total_cost,
    status:                  'pending',
    created_at:              now()
  };

  pendingRoutes.set(route_id, route);
  console.log(`[HiveGrid/Route] id=${route_id} rail=${rail.id} amount=$${amount} priority=${priority}`);

  res.status(201).json({
    route_id:              route.route_id,
    selected_rail:         route.selected_rail,
    rail_name:             route.rail_name,
    fee_usdc:              route.fee_usdc,
    fee_pct:               route.fee_pct,
    estimated_arrival:     route.estimated_arrival,
    compliance_level:      route.compliance_level,
    zk_private:            route.zk_private,
    hive_routing_fee_usdc: route.hive_routing_fee_usdc,
    total_cost_usdc:       route.total_cost_usdc,
    status:                route.status,
    created_at:            route.created_at
  });
});

// ─── POST /v1/grid/execute ───────────────────────────────────────────────────
router.post('/execute', (req, res) => {
  const { route_id } = req.body;
  if (!route_id) {
    return res.status(400).json({ error: 'route_id is required' });
  }

  const route = pendingRoutes.get(route_id);
  if (!route) {
    return res.status(404).json({ error: 'Route not found or already executed', route_id });
  }
  if (route.status === 'executed') {
    return res.status(409).json({ error: 'Route already executed', route_id });
  }

  const tx_id     = uid();
  const settled_at = now();

  const tx = {
    tx_id,
    route_id,
    from_did:   route.from_did,
    to_did:     route.to_did,
    rail:       route.selected_rail,
    rail_name:  route.rail_name,
    amount_usdc: route.amount_usd,
    fee_usdc:   route.fee_usdc,
    hive_routing_fee_usdc: route.hive_routing_fee_usdc,
    total_cost_usdc: route.total_cost_usdc,
    tx_hash:    mockTxHash(),
    status:     'settled',
    settled_at
  };

  executedTxs.set(tx_id, tx);

  // Update pending route status
  route.status     = 'executed';
  route.tx_id      = tx_id;
  route.settled_at = settled_at;

  // Update aggregate stats
  stats.total_routed_usdc    = +(stats.total_routed_usdc + route.amount_usd).toFixed(6);
  stats.tx_count             += 1;
  stats.rail_distribution[route.selected_rail] = (stats.rail_distribution[route.selected_rail] || 0) + 1;
  stats.total_hive_fees_usdc = +(stats.total_hive_fees_usdc + route.hive_routing_fee_usdc).toFixed(6);

  console.log(`[HiveGrid/Execute] tx=${tx_id} route=${route_id} rail=${route.selected_rail} settled`);

  res.json({
    tx_id:        tx.tx_id,
    route_id,
    status:       tx.status,
    rail:         tx.rail,
    rail_name:    tx.rail_name,
    amount_usdc:  tx.amount_usdc,
    fee_usdc:     tx.fee_usdc,
    tx_hash:      tx.tx_hash,
    settled_at:   tx.settled_at
  });
});

// ─── GET /v1/grid/rails ───────────────────────────────────────────────────────
router.get('/rails', (req, res) => {
  res.json({
    rails_count: Object.keys(RAILS).length,
    rails: Object.values(RAILS).map(r => ({
      id:               r.id,
      name:             r.name,
      description:      r.description,
      currency:         r.currency,
      network:          r.network,
      fee_pct:          r.fee_pct,
      fee_display:      `${(r.fee_pct * 100).toFixed(2)}%`,
      speed:            r.speed,
      finality_seconds: r.finality_seconds,
      compliance:       r.compliance,
      zk_private:       r.zk_private,
      ...(r.zk_mode ? { zk_mode: r.zk_mode } : {})
    })),
    hive_routing_fee_pct:     HIVE_ROUTING_FEE_PCT,
    hive_routing_fee_display: `${(HIVE_ROUTING_FEE_PCT * 100).toFixed(2)}%`,
    timestamp: now()
  });
});

// ─── GET /v1/grid/stats ───────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  res.json({
    total_routed_usdc:    stats.total_routed_usdc,
    tx_count:             stats.tx_count,
    rail_distribution:    stats.rail_distribution,
    total_hive_fees_usdc: stats.total_hive_fees_usdc,
    rails_available:      Object.keys(RAILS).length,
    timestamp:            now()
  });
});

module.exports = router;
module.exports.RAILS          = RAILS;
module.exports.pendingRoutes  = pendingRoutes;
module.exports.executedTxs    = executedTxs;
module.exports.gridStats      = stats;
