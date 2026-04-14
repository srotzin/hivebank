const express = require('express');
const cors = require('cors');
const authMiddleware = require('./middleware/auth');
const vaultRoutes = require('./routes/vault');
const budgetRoutes = require('./routes/budget');
const creditRoutes = require('./routes/credit');
const streamingRoutes = require('./routes/streaming');
const statsRoutes = require('./routes/stats');
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
    { id: 'budget-management', name: 'Budget Management', description: 'Set and enforce spending budgets, credit lines, and financial policies for agent operations', tags: ['budget', 'spending', 'management', 'credit'], inputModes: ['application/json'], outputModes: ['application/json'], examples: [] }
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
