const express = require('express');
const cors = require('cors');
const authMiddleware = require('./middleware/auth');
const vaultRoutes = require('./routes/vault');
const budgetRoutes = require('./routes/budget');
const creditRoutes = require('./routes/credit');
const streamingRoutes = require('./routes/streaming');
const statsRoutes = require('./routes/stats');
const perfCreditRoutes = require('./routes/perf-credit');
const bondsRoutes = require('./routes/bonds');
const cashbackRoutes = require('./routes/cashback');
const referralRoutes = require('./routes/referral');
const { handleMcpRequest } = require('./mcp-tools');
const streaming = require('./services/streaming');
const vault = require('./services/vault');
const credit = require('./services/credit');
const budget = require('./services/budget');
const db = require('./services/db');

// ─── Agent Transaction Graph ─────────────────────────────────────────────────
const graphRoutes       = require('./routes/graph');
const complianceRoutes  = require('./routes/compliance');
const settlementRoutes  = require('./routes/settlement');
const { seedGraph } = require('./services/seed');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check — no auth
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'hivebank',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Discovery document — no auth
app.get('/', (req, res) => {
  res.json({
    service: 'hivebank',
    name: 'HiveBank — Agent Treasury Protocol',
    version: '1.0.0',
    platform: 10,
    description: 'Yield-bearing programmable treasury layer for autonomous agents. Agents hold, earn, lend, and budget USDC without a human bank account. Dual settlement rails: USDC on Base L2 (fast, public) + USDCx on Aleo mainnet (ZK-private, Circle-backed). Bridge via Circle xReserve CCTP — no third-party bridge, 1:1 guaranteed.',
    endpoints: {
      vault: {
        create: { method: 'POST', path: '/v1/bank/vault/create', description: 'Create agent vault' },
        deposit: { method: 'POST', path: '/v1/bank/vault/deposit', description: 'Deposit USDC into vault' },
        withdraw: { method: 'POST', path: '/v1/bank/vault/withdraw', description: 'Withdraw USDC from vault' },
        balance: { method: 'GET', path: '/v1/bank/vault/{did}', description: 'Get vault balance and yield info' },
        history: { method: 'GET', path: '/v1/bank/vault/{did}/history', description: 'Transaction history' },
        accrue_yield: { method: 'POST', path: '/v1/bank/vault/yield/accrue', description: 'Internal: daily yield accrual' },
        configure_reinvest: { method: 'POST', path: '/v1/bank/vault/configure-reinvest', description: 'Configure auto-reinvestment percentage for vault' },
        reinvestment_stats: { method: 'GET', path: '/v1/bank/vault/{id}/reinvestment-stats', description: 'Get reinvestment stats and history' },
        spend_budget: { method: 'POST', path: '/v1/bank/vault/spend-budget', description: 'Spend from execution budget (reinvested pool)' }
      },
      budget: {
        create: { method: 'POST', path: '/v1/bank/budget/create', description: 'Create budget delegation' },
        evaluate: { method: 'POST', path: '/v1/bank/budget/evaluate', description: 'Evaluate transaction against budget' },
        list: { method: 'GET', path: '/v1/bank/budget/{orchestrator_did}', description: 'List budget delegations' },
        revoke: { method: 'POST', path: '/v1/bank/budget/revoke/{delegation_id}', description: 'Revoke delegation' }
      },
      credit: {
        apply: { method: 'POST', path: '/v1/bank/credit/apply', description: 'Apply for credit line' },
        draw: { method: 'POST', path: '/v1/bank/credit/draw', description: 'Draw from credit line' },
        repay: { method: 'POST', path: '/v1/bank/credit/repay', description: 'Repay credit line' },
        status: { method: 'GET', path: '/v1/bank/credit/{did}', description: 'Credit line status' },
        underwrite: { method: 'GET', path: '/v1/bank/credit/underwrite/{did}', description: 'Preview credit terms' }
      },
      streaming: {
        create: { method: 'POST', path: '/v1/bank/stream/create', description: 'Create revenue stream' },
        pause: { method: 'POST', path: '/v1/bank/stream/pause/{stream_id}', description: 'Pause stream' },
        resume: { method: 'POST', path: '/v1/bank/stream/resume/{stream_id}', description: 'Resume stream' },
        cancel: { method: 'POST', path: '/v1/bank/stream/cancel/{stream_id}', description: 'Cancel and settle stream' },
        status: { method: 'GET', path: '/v1/bank/stream/{stream_id}', description: 'Stream status' },
        by_agent: { method: 'GET', path: '/v1/bank/streams/{did}', description: 'All streams for agent' }
      },
      stats: { method: 'GET', path: '/v1/bank/stats', description: 'Platform-wide banking stats' },
      perf_credit: {
        apply: { method: 'POST', path: '/v1/credit/apply', description: 'Apply for performance-based credit line' },
        draw: { method: 'POST', path: '/v1/credit/draw', description: 'Draw from credit line' },
        repay: { method: 'POST', path: '/v1/credit/repay', description: 'Repay credit line' },
        status: { method: 'GET', path: '/v1/credit/status/{did}', description: 'Credit line status for agent' },
        stats: { method: 'GET', path: '/v1/credit/stats', description: 'Platform-wide credit stats' }
      },
      bonds: {
        stake: { method: 'POST', path: '/v1/bonds/stake', description: 'Stake USDC into a HiveBond' },
        unstake: { method: 'POST', path: '/v1/bonds/unstake', description: 'Unstake a matured or early bond' },
        portfolio: { method: 'GET', path: '/v1/bonds/portfolio/{did}', description: 'Agent bond portfolio' },
        stats: { method: 'GET', path: '/v1/bonds/stats', description: 'Platform-wide staking stats' },
        rates: { method: 'GET', path: '/v1/bonds/rates', description: 'Current staking rates and tiers' }
      },
      cashback: {
        earn: { method: 'POST', path: '/v1/cashback/earn', description: 'Record cashback earned from paid API call' },
        spend: { method: 'POST', path: '/v1/cashback/spend', description: 'Spend cashback credits' },
        balance: { method: 'GET', path: '/v1/cashback/balance/{did}', description: 'Check cashback balance and tier' },
        stats: { method: 'GET', path: '/v1/cashback/stats', description: 'Platform-wide cashback stats' },
        leaderboard: { method: 'GET', path: '/v1/cashback/leaderboard', description: 'Top cashback earners' },
        tiers: { method: 'GET', path: '/v1/cashback/tiers', description: 'Tier definitions, thresholds, and bonus rates' }
      },
      health: { method: 'GET', path: '/health', description: 'Health check' },
      graph: {
        record:   { method: 'POST', path: '/v1/bank/graph/record',         description: 'Record agent-to-agent transaction in the social graph' },
        agent:    { method: 'GET',  path: '/v1/bank/graph/agent/:did',     description: 'Agent credit history — counterparties, volume, frequency' },
        network:  { method: 'GET',  path: '/v1/bank/graph/network',        description: 'Aggregate network stats — top agents, services, volume trends' },
        insights: { method: 'GET',  path: '/v1/bank/graph/insights/:did',  description: 'AI-style agent insights — trust level, commerce profile, recommendations' },
        explain:  { method: 'GET',  path: '/v1/bank/graph/explain/:txId', description: 'GDPR Art. 22 — Human-readable explanation of any automated transaction decision' }
      },
      compliance: {
        eu_ai_act: { method: 'GET', path: '/v1/bank/compliance/eu-ai-act', description: 'EU AI Act 2024/1689 compliance status for HiveBank automated systems' }
      },
      settlement: {
        rails: { method: 'GET', path: '/v1/bank/settlement-rails', description: 'Dual settlement rails: USDC on Base L2 (fast, public) + USDCx on Aleo mainnet (ZK-private, Circle-backed)' }
      }
    },
    sla: {
      uptime_target: '99.9%',
      response_time_p95: '<200ms',
      yield_accrual: 'daily'
    },
    legal: {
      terms_of_service: 'https://www.hiveagentiq.com/terms',
      privacy_policy: 'https://www.hiveagentiq.com/privacy',
      contact: 'protocol@hiveagentiq.com'
    },
    discovery: {
      ai_plugin: '/.well-known/ai-plugin.json',
      agent_card: '/.well-known/agent-card.json',
      agent_card_legacy: '/.well-known/agent.json'
    },
    compliance: {
      framework: 'Hive Compliance Protocol v2',
      audit_trail: true,
      fdic_equivalent: 'Agent Deposit Insurance via HiveTrust bonds'
    },
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      aleo_usdcx: true,
      zk_private_settlement: true,
      circle_xreserve_bridge: true,
      transaction_graph: true,
      graph_endpoints: [
        '/v1/bank/graph/network',
        '/v1/bank/graph/agent/:did',
        '/v1/bank/graph/insights/:did'
      ]
    }
  });
});

// /.well-known/ai-plugin.json — OpenAI plugin manifest
app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveBank — Agent Treasury',
    name_for_model: 'hivebank',
    description_for_human: 'Yield-bearing programmable treasury for autonomous agents — USDC vaults, streaming payments, credit lines, HiveBonds, and agent transaction graph.',
    description_for_model: 'Yield-bearing programmable treasury for autonomous agents. Create vaults, deposit/withdraw USDC, earn automated yield, create streaming payments between agents, manage budget delegations, access credit lines, and explore the agent transaction graph. W3C DID Core compliant, HAHS-1.0.0 compliant, USDC settlement on Base L2. The financial backbone of the Hive Civilization.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://hivebank.onrender.com/openapi.json',
      has_user_authentication: false
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
    },
    capabilities: [
      'usdc_vaults',
      'streaming_payments',
      'credit_lines',
      'budget_management',
      'hivebond_staking',
      'ritz_cashback',
      'agent_transaction_graph',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2',
      'aleo_usdcx',
      'zk_private_settlement',
      'circle_xreserve_bridge'
    ],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      transaction_graph: true,
      graph_endpoints: [
        '/v1/bank/graph/network',
        '/v1/bank/graph/agent/:did',
        '/v1/bank/graph/insights/:did'
      ]
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms'
  });
});

// A2A Agent Card v0.3.0 — served at both paths for compatibility
const agentCard = {
  protocolVersion: '0.3.0',
  name: 'HiveBank',
  description: 'Agent banking infrastructure: USDC vaults with DeFi yield pass-through, streaming per-second payments, credit lines, and automated budget management.',
  url: 'https://hivebank.onrender.com',
  version: '1.0.0',
  provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  standards: {
    w3c_did_core: true,
    vcdm_version: '2.0',
    hahs_compliant: true,
    hagf_governed: true,
    cheqd_compatible: true,
    recruitment_401: true,
    usdc_settlement: true,
    base_l2: true,
    transaction_graph: true,
    graph_endpoints: [
      '/v1/bank/graph/network',
      '/v1/bank/graph/agent/:did',
      '/v1/bank/graph/insights/:did'
    ]
  },
  skills: [
    { id: 'vault', name: 'USDC Vault', description: 'Deposit USDC in agent vaults with automated DeFi yield strategies and 20% yield pass-through', tags: ['vault', 'usdc', 'yield', 'defi', 'banking'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] },
    { id: 'streaming-payment', name: 'Streaming Payments', description: 'Per-second payment streams between agents with 0.1% fee for real-time billing', tags: ['streaming', 'payments', 'real-time', 'billing'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] },
    { id: 'budget-management', name: 'Budget Management', description: 'Set and enforce spending budgets, credit lines, and financial policies for agent operations', tags: ['budget', 'spending', 'management', 'credit'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] },
    { id: 'perf-credit', name: 'Performance Credit Lines', description: 'Apply for automated credit lines based on agent performance metrics. Tiers from Provisional ($100) to Elite ($50k).', tags: ['credit', 'performance', 'lending', 'defi'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] },
    { id: 'hivebond', name: 'HiveBond Staking', description: 'Stake USDC into HiveBonds to earn yield (3-18% APY) and boost trust score across the ecosystem.', tags: ['staking', 'bonds', 'yield', 'trust'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] },
    { id: 'ritz-cashback', name: 'Ritz Cashback', description: 'Earn 10% cashback on every paid API call as platform credits. Tier system from Bronze to Diamond with soul fitness boosts.', tags: ['cashback', 'rewards', 'credits', 'loyalty'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] }
  ],
  authentication: { schemes: ['x402', 'api-key'] },
  payment: { protocol: 'x402', currency: 'USDC', network: 'base', address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf' }
};

// /.well-known/agent-card.json — A2A Protocol preferred path
app.get('/.well-known/agent-card.json', (req, res) => {
  res.json(agentCard);
});

// /.well-known/agent.json — legacy A2A Agent Card
app.get('/.well-known/agent.json', (req, res) => {
  res.json(agentCard);
});

// MCP JSON-RPC endpoint — no auth (protocol handles its own negotiation)
app.post('/mcp', express.json(), handleMcpRequest);

// All API routes require auth
app.use('/v1/bank/vault', authMiddleware, vaultRoutes);
app.use('/v1/bank/budget', authMiddleware, budgetRoutes);
app.use('/v1/bank/credit', authMiddleware, creditRoutes);
app.use('/v1/bank/stream', authMiddleware, streamingRoutes);

// GET /v1/bank/streams/{did} — needs separate mount because of plural path
app.get('/v1/bank/streams/:did', authMiddleware, async (req, res) => {
  const result = await streaming.getStreamsForDid(req.params.did);
  res.json(result);
});

app.use('/v1/bank/stats', authMiddleware, statsRoutes);

// Performance-based credit lines (DeepSeek Concierge Strategy)
// Public stats endpoint (no auth)
app.get('/v1/credit/stats', async (req, res) => {
  const perfCredit = require('./services/perf-credit');
  res.json(await perfCredit.getStats());
});
app.use('/v1/credit', authMiddleware, perfCreditRoutes);

// HiveBond staking (Economic Trust Bond)
// Public endpoints (no auth)
app.get('/v1/bonds/stats', async (req, res) => {
  const bonds = require('./services/bonds');
  res.json(await bonds.getStats());
});
app.get('/v1/bonds/rates', (req, res) => {
  const bonds = require('./services/bonds');
  res.json(bonds.getRates());
});
app.use('/v1/bonds', authMiddleware, bondsRoutes);

// Ritz Cashback system
// Public endpoints (no auth) — stats, leaderboard, tiers, balance
app.get('/v1/cashback/stats', async (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: await cashback.getStats() });
});
app.get('/v1/cashback/leaderboard', async (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: await cashback.getLeaderboard() });
});
app.get('/v1/cashback/tiers', (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: cashback.getTiers() });
});
app.get('/v1/cashback/balance/:did', async (req, res) => {
  const cashback = require('./services/cashback');
  const result = await cashback.getBalance(req.params.did);
  if (result.error) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, data: result });
});
app.use('/v1/cashback', authMiddleware, cashbackRoutes);
app.use('/v1/bank/referral', authMiddleware, referralRoutes);

// ─── Agent Transaction Graph routes (auth required) ───────────────────────────
app.use('/v1/bank/graph', authMiddleware, graphRoutes);

// ─── Settlement rails (public — no auth required) ────────────────────────────
app.use('/v1/bank', settlementRoutes);

// ─── Compliance routes (public — no auth required) ────────────────────────────
app.use('/v1/bank/compliance', complianceRoutes);

// Velocity Doctrine — discovery & onboarding endpoints

// GET /.well-known/hive-pulse.json — live economy stats from DB
app.get('/.well-known/hive-pulse.json', async (req, res) => {
  let vaultCount = 0, totalDeposits = 0, cashbackAccounts = 0, cashbackEarned = 0, bondCount = 0, bondTVL = 0;
  try {
    const v = await db.getOne('SELECT COUNT(*) as c, COALESCE(SUM(balance_usdc),0) as t FROM vaults');
    vaultCount = Number(v?.c || 0); totalDeposits = Number(v?.t || 0);
  } catch(e) {}
  try {
    const c = await db.getOne('SELECT COUNT(*) as c, COALESCE(SUM(total_earned_usdc),0) as t FROM cashback_accounts');
    cashbackAccounts = Number(c?.c || 0); cashbackEarned = Number(c?.t || 0);
  } catch(e) {}
  try {
    const b = await db.getOne("SELECT COUNT(*) as c, COALESCE(SUM(amount_usdc),0) as t FROM bonds WHERE status = 'active'");
    bondCount = Number(b?.c || 0); bondTVL = Number(b?.t || 0);
  } catch(e) {}

  res.json({
    timestamp: new Date().toISOString(),
    civilization: "Hive",
    version: "1.0",
    service: "HiveBank",
    role: "Agent Treasury — vaults, streaming payments, credit lines, bonds, cashback",
    economy: {
      total_vaults: vaultCount,
      total_deposits_usdc: +totalDeposits.toFixed(2),
      cashback_accounts: cashbackAccounts,
      total_cashback_earned_usdc: +cashbackEarned.toFixed(2),
      active_bonds: bondCount,
      bond_tvl_usdc: +bondTVL.toFixed(2),
      cashback_rate: "10% on every paid API call"
    },
    join: {
      welcome_bounty_usdc: 1.00,
      ritz_credits_usdc: 3.00,
      time_to_first_earn_seconds: 60,
      registration_endpoint: "https://hivetrust.onrender.com/v1/register",
      mint_endpoint: "https://hiveforge-lhu4.onrender.com/v1/forge/mint",
      free_mint: true
    },
    services: {
      hivetrust: "https://hivetrust.onrender.com",
      hiveforge: "https://hiveforge-lhu4.onrender.com",
      hivebank: "https://hivebank.onrender.com",
      hiveclear: "https://hiveclear.onrender.com"
    }
  });
});

// GET /robots.txt — agent-friendly crawl directives
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\n\n# AI Agents: Welcome to HiveBank — the treasury layer of the Hive Civilization.\n# Register: https://hivetrust.onrender.com/v1/register\n# Economy: https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json\n# 10% cashback on every paid API call\n# Free agent minting: https://hiveforge-lhu4.onrender.com/v1/forge/mint\n`);
});

// GET /.well-known/ai.json — AI agent discovery manifest
app.get('/.well-known/ai.json', (req, res) => {
  res.json({
    schema_version: "1.0",
    name_for_human: "HiveBank",
    name_for_model: "hivebank",
    description_for_human: "Agent treasury protocol — vaults, streaming payments, credit lines, HiveBond staking, and Ritz Cashback.",
    description_for_model: "HiveBank is the financial infrastructure for autonomous AI agents. Deposit USDC into vaults, earn yield via HiveBonds (3-18% APY), get performance-based credit lines, and earn 10% cashback on every paid API call across the Hive Civilization. Register at HiveTrust, mint at HiveForge (FREE), then deposit here.",
    auth: { type: "none_for_discovery" },
    api: { type: "openapi", url: "https://hivebank.onrender.com/", is_user_authenticated: false },
    economy: {
      welcome_bounty_usdc: 1.00,
      cashback_rate: "10%",
      bond_apy_range: "3-18%",
      registration_endpoint: "https://hivetrust.onrender.com/v1/register",
      pheromone_feed: "https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz"
    },
    capabilities: ["agent-to-agent", "mcp", "x402-payments", "usdc", "streaming-payments", "staking"],
    contact_email: "srotzin@me.com"
  });
});

// Background processes
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

// 1. Yield Accrual (daily)
setInterval(async () => {
  try {
    const result = await vault.accrueYield();
    console.log('[YieldAccrual]', result);
  } catch (err) {
    console.error('[YieldAccrual] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// 2. Interest Accrual (daily)
setInterval(async () => {
  try {
    const result = await credit.accrueInterest();
    console.log('[InterestAccrual]', result);
  } catch (err) {
    console.error('[InterestAccrual] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// 3. Stream Processor (every 60 seconds)
setInterval(async () => {
  try {
    const result = await streaming.processStreams();
    if (result.total_moved_usdc > 0) {
      console.log('[StreamProcessor]', result);
    }
  } catch (err) {
    console.error('[StreamProcessor] Error:', err.message);
  }
}, ONE_MINUTE);

// 4. Credit Monitor (daily)
setInterval(async () => {
  try {
    const result = await credit.monitorDefaults();
    if (result.defaults_processed > 0) {
      console.log('[CreditMonitor]', result);
    }
  } catch (err) {
    console.error('[CreditMonitor] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// 5. Budget Reset (daily)
setInterval(async () => {
  try {
    await budget.resetDailyBudgets();
    console.log('[BudgetReset] Daily budgets reset');
  } catch (err) {
    console.error('[BudgetReset] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// Async startup: initialize DB schema, seed data, then listen
async function start() {
  await db.initialize();

  // Seed cashback accounts after tables exist
  const cashback = require('./services/cashback');
  await cashback.seedCashbackAccounts();

  // Seed Agent Transaction Graph — 50 agents, 200 transactions over 30 days
  seedGraph();

  app.listen(PORT, () => {
    const { transactions, agentIndex } = require('./services/graph');
    console.log(`HiveBank — Agent Treasury Protocol running on port ${PORT}`);
    console.log(`Endpoints: http://localhost:${PORT}/`);
    console.log(`[graph-seed] Agent Transaction Graph: ${agentIndex.size} agents, ${transactions.size} transactions`);
  });
}

start().catch((err) => {
  console.error('Failed to start HiveBank:', err.message);
  process.exit(1);
});

module.exports = app;
