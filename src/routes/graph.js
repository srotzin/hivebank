/**
 * Agent Transaction Graph — Routes
 * The Bloomberg Terminal of agent commerce.
 *
 * POST   /v1/bank/graph/record        — Record a transaction between two agents
 * GET    /v1/bank/graph/agent/:did    — Agent credit history & graph
 * GET    /v1/bank/graph/network       — Aggregate network stats
 * GET    /v1/bank/graph/insights/:did — AI-style agent insights
 */

const express = require('express');
const router  = express.Router();
const { ok, err } = require('../ritz');
const {
  recordTransaction,
  getAgentGraph,
  getNetworkStats,
  getAgentInsights,
} = require('../services/graph');

const SVC = 'hivebank';

// ─── POST /v1/bank/graph/record ─────────────────────────────────────────────
router.post('/record', (req, res) => {
  const { from_did, to_did, amount_usdc, service, fee_collected, timestamp } = req.body || {};

  // Validation
  if (!from_did || typeof from_did !== 'string' || !from_did.trim()) {
    return err(res, SVC, 'MISSING_FROM_DID', 'from_did is required and must be a non-empty string.', 400, {
      recovery_actions: ['Provide a valid DID in the format did:hive:<identifier>'],
    });
  }
  if (!to_did || typeof to_did !== 'string' || !to_did.trim()) {
    return err(res, SVC, 'MISSING_TO_DID', 'to_did is required and must be a non-empty string.', 400, {
      recovery_actions: ['Provide a valid DID in the format did:hive:<identifier>'],
    });
  }
  if (from_did === to_did) {
    return err(res, SVC, 'SELF_TRANSACTION', 'from_did and to_did cannot be the same agent.', 400, {
      recovery_actions: ['Ensure from_did and to_did are different agent DIDs'],
    });
  }
  if (typeof amount_usdc !== 'number' || isNaN(amount_usdc) || amount_usdc <= 0) {
    return err(res, SVC, 'INVALID_AMOUNT', 'amount_usdc must be a positive number.', 400, {
      recovery_actions: ['Provide amount_usdc as a positive number (e.g. 127.50)'],
    });
  }
  if (!service || typeof service !== 'string') {
    return err(res, SVC, 'MISSING_SERVICE', 'service is required (e.g. HiveTrust, HiveClear, HiveBank).', 400, {
      valid_services: ['HiveTrust', 'HiveBank', 'HiveClear', 'HiveGate', 'HiveMind', 'HiveLaw'],
    });
  }

  try {
    const tx = recordTransaction({ from_did, to_did, amount_usdc, service, fee_collected, timestamp });

    return ok(res, SVC, {
      transaction:    tx,
      graph_updated:  true,
      from_agent_txs: null, // lazy — fetch via GET /graph/agent/:did
      to_agent_txs:   null,
    }, { recorded: true }, 201);
  } catch (e) {
    return err(res, SVC, 'RECORD_FAILED', e.message, 500);
  }
});

// ─── GET /v1/bank/graph/agent/:did ──────────────────────────────────────────
router.get('/agent/:did', (req, res) => {
  const { did } = req.params;

  if (!did || !did.trim()) {
    return err(res, SVC, 'MISSING_DID', 'DID parameter is required.', 400);
  }

  const graph = getAgentGraph(did);

  if (!graph) {
    return err(res, SVC, 'AGENT_NOT_FOUND',
      `No transaction history found for DID ${did}. This agent has not yet transacted on the Hive network.`,
      404, {
        recovery_actions: [
          'Register this agent via POST https://hivetrust.onrender.com/v1/register',
          'Record a first transaction via POST /v1/bank/graph/record',
        ],
      });
  }

  return ok(res, SVC, {
    agent_credit_history: graph,
    _links: {
      insights: `/v1/bank/graph/insights/${encodeURIComponent(did)}`,
      network:  '/v1/bank/graph/network',
      record:   '/v1/bank/graph/record',
    },
  });
});

// ─── GET /v1/bank/graph/network ─────────────────────────────────────────────
router.get('/network', (req, res) => {
  try {
    const stats = getNetworkStats();
    return ok(res, SVC, {
      network_stats: stats,
      _links: {
        agent_graph: '/v1/bank/graph/agent/:did',
        insights:    '/v1/bank/graph/insights/:did',
        record:      '/v1/bank/graph/record',
      },
    }, {
      note: 'Pre-populated with seed data. All live transactions appended in real-time.',
    });
  } catch (e) {
    return err(res, SVC, 'NETWORK_STATS_FAILED', e.message, 500);
  }
});

// ─── GET /v1/bank/graph/insights/:did ───────────────────────────────────────
router.get('/insights/:did', (req, res) => {
  const { did } = req.params;

  if (!did || !did.trim()) {
    return err(res, SVC, 'MISSING_DID', 'DID parameter is required.', 400);
  }

  const insights = getAgentInsights(did);

  if (!insights) {
    return err(res, SVC, 'AGENT_NOT_FOUND',
      `No transaction history found for DID ${did}. Cannot generate insights without transaction data.`,
      404, {
        recovery_actions: [
          'Record transactions for this agent via POST /v1/bank/graph/record',
          'Register the agent at https://hivetrust.onrender.com/v1/register',
        ],
      });
  }

  return ok(res, SVC, { insights }, {
    model: 'hive-graph-intelligence-v1',
    generated_at: new Date().toISOString(),
  });
});

module.exports = router;
