const express = require('express');
const router = express.Router();
const db = require('../services/db');

router.get('/', (req, res) => {
  const stats = db.prepare('SELECT * FROM bank_stats WHERE id = 1').get();
  const total_vaults = db.prepare('SELECT COUNT(*) as count FROM vaults').get().count;
  const active_credit_lines = db.prepare("SELECT COUNT(*) as count FROM credit_lines WHERE status = 'active'").get().count;
  const active_streams = db.prepare("SELECT COUNT(*) as count FROM revenue_streams WHERE status = 'active'").get().count;

  const today = new Date().toISOString().split('T')[0];
  const evals_today = db.prepare(
    "SELECT COUNT(*) as count FROM budget_evaluations WHERE evaluated_at >= ?"
  ).get(today + 'T00:00:00.000Z').count;

  const active_reinvestors = db.prepare(
    "SELECT COUNT(*) as count FROM vaults WHERE reinvest_enabled = 1"
  ).get().count;

  res.json({
    total_vaults,
    total_deposits_usdc: stats.total_deposits_usdc,
    total_yield_generated_usdc: stats.total_yield_generated_usdc,
    platform_yield_revenue_usdc: stats.platform_yield_revenue_usdc,
    active_credit_lines,
    total_credit_outstanding_usdc: stats.total_credit_outstanding_usdc,
    active_streams,
    total_streamed_volume_usdc: stats.total_streamed_volume_usdc,
    budget_evaluations_today: evals_today,
    total_reinvested_usdc: stats.total_reinvested_usdc,
    active_reinvestors
  });
});

module.exports = router;
