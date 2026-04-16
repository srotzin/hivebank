/**
 * Agent Transaction Graph — Routes
 * The Bloomberg Terminal of agent commerce.
 *
 * POST   /v1/bank/graph/record           — Record a transaction between two agents
 * GET    /v1/bank/graph/agent/:did       — Agent credit history & graph
 * GET    /v1/bank/graph/network          — Aggregate network stats
 * GET    /v1/bank/graph/insights/:did    — AI-style agent insights
 * GET    /v1/bank/graph/explain/:txId    — GDPR Art. 22 human-readable explanation
 */

const express = require('express');
const router  = express.Router();
const { ok, err } = require('../ritz');
const {
  recordTransaction,
  getAgentGraph,
  getNetworkStats,
  getAgentInsights,
  transactions,
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

// ─── GET /v1/bank/graph/explain/:txId ───────────────────────────────────────
// GDPR Article 22 — Automated Decision Explanation
router.get('/explain/:txId', (req, res) => {
  const { txId } = req.params;

  if (!txId || !txId.trim()) {
    return err(res, SVC, 'MISSING_TX_ID', 'txId parameter is required.', 400);
  }

  const tx = transactions.get(txId);

  if (!tx) {
    // Graceful not-found: still explains the GDPR right
    return res.status(404).json({
      success: false,
      service: SVC,
      error: {
        code: 'TRANSACTION_NOT_FOUND',
        message: `Transaction ${txId} was not found in the HiveBank ledger.`,
      },
      gdpr_notice: {
        right: 'GDPR Article 22 — Right to Explanation for Automated Decisions',
        description:
          'Under GDPR Article 22, any individual or agent subject to a solely automated decision ' +
          'that produces legal or similarly significant effects has the right to obtain a meaningful ' +
          'explanation of the logic involved, as well as the right to request human review.',
        what_this_endpoint_does:
          'GET /v1/bank/graph/explain/:txId returns a plain-English explanation of any transaction ' +
          'recorded in HiveBank, including the agents involved, the amount, the service that triggered ' +
          'the transaction, and the data fields that drove the automated decision.',
        human_review_available: true,
        human_review_endpoint: `POST /v1/bank/graph/review-request/${txId}`,
        legal_basis: 'GDPR Article 22 — Automated Decision Explanation',
        gdpr_contact: 'privacy@thehiveryiq.com',
      },
      timestamp: new Date().toISOString(),
    });
  }

  // Format date for human-readable explanation
  const txDate = new Date(tx.timestamp);
  const formattedDate = txDate.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  const explanation =
    `Agent ${tx.from_did} paid ${tx.amount_usdc.toFixed(2)} USDC to Agent ${tx.to_did} ` +
    `for ${tx.service} on ${formattedDate}. ` +
    `This transaction was initiated automatically based on a programmatic request to the HiveBank ` +
    `${tx.service} service. No human was involved in this decision.`;

  return res.json({
    success: true,
    service: SVC,
    data: {
      transaction_id: tx.tx_id,
      explanation,
      legal_basis: 'GDPR Article 22 — Automated Decision Explanation',
      data_used: [
        'from_did',
        'to_did',
        'amount_usdc',
        'service',
        'timestamp',
        'fee_collected',
      ],
      transaction_details: {
        from_did:      tx.from_did,
        to_did:        tx.to_did,
        amount_usdc:   tx.amount_usdc,
        service:       tx.service,
        fee_collected: tx.fee_collected,
        timestamp:     tx.timestamp,
        recorded_at:   tx.recorded_at,
        settled:       tx.graph_metadata?.settled ?? true,
      },
      human_review_available: true,
      human_review_endpoint:  `POST /v1/bank/graph/review-request/${tx.tx_id}`,
      gdpr_contact: 'privacy@thehiveryiq.com',
    },
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
