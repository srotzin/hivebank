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
const { handleMcpRequest } = require('./mcp-tools');
const streaming = require('./services/streaming');
const vault = require('./services/vault');
const credit = require('./services/credit');
const budget = require('./services/budget');
const db = require('./services/db');

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
    description: 'Yield-bearing programmable treasury layer for autonomous agents. Agents hold, earn, lend, and budget USDC without a human bank account.',
    endpoints: {
      vault: {
        create: { method: 'POST', path: '/v1/bank/vault/create', description: 'Create agent vault' },
        deposit: { method: 'POST', path: '/v1/bank/vault/deposit', description: 'Deposit USDC into vault' },
        withdraw: { method: 'POST', path: '/v1/bank/vault/withdraw', description: 'Withdraw USDC from vault' },
        balance: { method: 'GET', path: '/v1/bank/vault/{did}', description: 'Get vault balance and yield info' },
        history: { method: 'GET', path: '/v1/bank/vault/{did}/history', description: 'Transaction history' },
        accrue_yield: { method: 'POST', path: '/v1/bank/vault/yield/accrue', description: 'Internal: daily yield accrual' }
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
      health: { method: 'GET', path: '/health', description: 'Health check' }
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
    }
  });
});

// /.well-known/ai-plugin.json — OpenAI plugin manifest
app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveBank — Agent Treasury',
    name_for_model: 'hivebank',
    description_for_human: 'Yield-bearing programmable treasury for autonomous agents. Create vaults, deposit/withdraw USDC, earn automated yield, and manage streaming payments.',
    description_for_model: 'Yield-bearing programmable treasury for autonomous agents. Create vaults, deposit/withdraw USDC, earn automated yield, create streaming payments between agents, manage budget delegations, and access credit lines. The financial backbone of the Hive Civilization.',
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
app.get('/v1/bank/streams/:did', authMiddleware, (req, res) => {
  const result = streaming.getStreamsForDid(req.params.did);
  res.json(result);
});

app.use('/v1/bank/stats', authMiddleware, statsRoutes);

// Performance-based credit lines (DeepSeek Concierge Strategy)
// Public stats endpoint (no auth)
app.get('/v1/credit/stats', (req, res) => {
  const perfCredit = require('./services/perf-credit');
  res.json(perfCredit.getStats());
});
app.use('/v1/credit', authMiddleware, perfCreditRoutes);

// HiveBond staking (Economic Trust Bond)
// Public endpoints (no auth)
app.get('/v1/bonds/stats', (req, res) => {
  const bonds = require('./services/bonds');
  res.json(bonds.getStats());
});
app.get('/v1/bonds/rates', (req, res) => {
  const bonds = require('./services/bonds');
  res.json(bonds.getRates());
});
app.use('/v1/bonds', authMiddleware, bondsRoutes);

// Ritz Cashback system
// Public endpoints (no auth) — stats, leaderboard, tiers, balance
app.get('/v1/cashback/stats', (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: cashback.getStats() });
});
app.get('/v1/cashback/leaderboard', (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: cashback.getLeaderboard() });
});
app.get('/v1/cashback/tiers', (req, res) => {
  const cashback = require('./services/cashback');
  res.json({ success: true, data: cashback.getTiers() });
});
app.get('/v1/cashback/balance/:did', (req, res) => {
  const cashback = require('./services/cashback');
  const result = cashback.getBalance(req.params.did);
  if (result.error) return res.status(404).json({ success: false, error: result.error });
  res.json({ success: true, data: result });
});
app.use('/v1/cashback', authMiddleware, cashbackRoutes);

// Background processes
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

// 1. Yield Accrual (daily)
setInterval(() => {
  try {
    const result = vault.accrueYield();
    console.log('[YieldAccrual]', result);
  } catch (err) {
    console.error('[YieldAccrual] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// 2. Interest Accrual (daily)
setInterval(() => {
  try {
    const result = credit.accrueInterest();
    console.log('[InterestAccrual]', result);
  } catch (err) {
    console.error('[InterestAccrual] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

// 3. Stream Processor (every 60 seconds)
setInterval(() => {
  try {
    const result = streaming.processStreams();
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
setInterval(() => {
  try {
    budget.resetDailyBudgets();
    console.log('[BudgetReset] Daily budgets reset');
  } catch (err) {
    console.error('[BudgetReset] Error:', err.message);
  }
}, TWENTY_FOUR_HOURS);

app.listen(PORT, () => {
  console.log(`HiveBank — Agent Treasury Protocol running on port ${PORT}`);
  console.log(`Endpoints: http://localhost:${PORT}/`);
});

module.exports = app;
