const express = require('express');
const router = express.Router();
const db = require('../services/db');

router.get('/', async (req, res) => {
  const stats = await db.getOne('SELECT * FROM bank_stats WHERE id = 1');
  const total_vaults = (await db.getOne('SELECT COUNT(*) as count FROM vaults')).count;
  const active_credit_lines = (await db.getOne("SELECT COUNT(*) as count FROM credit_lines WHERE status = 'active'")).count;
  const active_streams = (await db.getOne("SELECT COUNT(*) as count FROM revenue_streams WHERE status = 'active'")).count;

  const today = new Date().toISOString().split('T')[0];
  const evals_today = (await db.getOne(
    "SELECT COUNT(*) as count FROM budget_evaluations WHERE evaluated_at >= $1",
    [today + 'T00:00:00.000Z']
  )).count;

  const active_reinvestors = (await db.getOne(
    "SELECT COUNT(*) as count FROM vaults WHERE reinvest_enabled = 1"
  )).count;

  res.json({
    total_vaults: Number(total_vaults),
    total_deposits_usdc: Number(stats.total_deposits_usdc),
    total_yield_generated_usdc: Number(stats.total_yield_generated_usdc),
    platform_yield_revenue_usdc: Number(stats.platform_yield_revenue_usdc),
    active_credit_lines: Number(active_credit_lines),
    total_credit_outstanding_usdc: Number(stats.total_credit_outstanding_usdc),
    active_streams: Number(active_streams),
    total_streamed_volume_usdc: Number(stats.total_streamed_volume_usdc),
    budget_evaluations_today: Number(evals_today),
    total_reinvested_usdc: Number(stats.total_reinvested_usdc),
    active_reinvestors: Number(active_reinvestors)
  });
});

module.exports = router;
