/**
 * HiveBank Compliance Routes
 *
 * GET /v1/bank/compliance/eu-ai-act — EU AI Act 2024/1689 compliance status
 */

const express = require('express');
const router  = express.Router();

// ─── GET /v1/bank/compliance/eu-ai-act ──────────────────────────────────────
router.get('/eu-ai-act', (req, res) => {
  // Full enforcement date: 2 August 2026
  const enforcementDate = new Date('2026-08-02T00:00:00.000Z');
  const referenceDate   = new Date('2026-04-15T00:00:00.000Z');
  const msPerDay        = 24 * 60 * 60 * 1000;
  const daysUntilEnforcement = Math.ceil(
    (enforcementDate - referenceDate) / msPerDay
  );

  return res.json({
    regulation:    'EU AI Act 2024/1689',
    effective_date: '2026-08-02',
    days_until_enforcement: daysUntilEnforcement,
    hivebank_status: {
      article_12_transparency: {
        status:   'compliant',
        detail:   'Agent Transaction Graph provides full audit trail for all automated decisions',
        endpoint: '/v1/bank/graph/explain/:txId',
      },
      article_13_information: {
        status: 'compliant',
        detail: 'All agent transactions include human-readable explanations via explain_transaction API',
      },
      article_14_human_oversight: {
        status: 'compliant',
        detail: 'POST /v1/bank/graph/review-request/:txId available for any transaction',
      },
      article_9_risk_management: {
        status: 'compliant',
        detail: 'Trust score gating prevents high-risk agents from accessing credit lines',
      },
      article_17_quality_management: {
        status: 'partial',
        detail: 'Agent Transaction Graph logs all decisions; formal QMS documentation in progress',
      },
    },
    settlement_privacy: {
      status: 'compliant',
      gdpr_article_25: 'Privacy by Design',
      detail: 'Hive supports ZK-private settlement via USDCx on Aleo mainnet (Circle xReserve, 1:1 USDC-backed). Agent transaction amounts and counterparties are hidden by zero-knowledge proof by default — satisfying GDPR Article 25 (Data Protection by Design and by Default) for agent financial transactions.',
      settlement_rails: '/v1/bank/settlement-rails',
      zk_program: 'hive_trust.aleo',
      privacy_model: 'Transaction amounts, counterparties, and balances are private by default on Aleo. Only the ZK proof that thresholds are met is public.',
      mainnet_launch: '2026-01-27',
      bridge: 'Circle xReserve + CCTP — no third-party bridge, 1:1 guaranteed',
    },
    overall_status: 'substantially_compliant',
    gaps: [
      'Formal quality management system documentation',
      'Conformity assessment for high-risk use cases',
    ],
    next_steps: 'Contact Steve Rotzin at srotzin@me.com for enterprise EU AI Act compliance package',
  });
});

module.exports = router;
