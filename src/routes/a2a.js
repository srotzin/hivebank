/**
 * a2a.js — A2A Protocol JSON-RPC Endpoint (HiveBank)
 *
 * Implements A2A spec v0.2.1 at POST /
 * Also handles legacy v0.1 tasks/send method name.
 *
 * Spec: https://google.github.io/A2A/specification/
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();

const SERVICE_NAME = 'HiveBank';
const SERVICE_URL  = 'https://hivebank.onrender.com';
const ONBOARD_URL  = 'https://hivegate.onrender.com/v1/gate/onboard';

const TASKS = new Map();

function contextId() { return 'ctx-' + crypto.randomBytes(8).toString('hex'); }

const SKILLS = [
  { keyword: ['vault', 'deposit', 'withdraw', 'balance'],   skill: 'vault',      description: 'USDC vaults with automated DeFi yield (Aave/Morpho/Spark/Compound)' },
  { keyword: ['pay', 'send', 'payment', 'transfer'],        skill: 'payment',    description: 'HivePay — send any asset to any DID, no chain questions asked' },
  { keyword: ['wallet', 'mpc', 'eth', 'btc', 'sol', 'doge'], skill: 'wallet',   description: 'HiveWallet MPC — hold ETH/BTC/SOL/DOGE/USDC + 100 more assets' },
  { keyword: ['treasury', 'address', 'deposit address'],    skill: 'treasury',   description: 'MPC Treasury — get deposit addresses for any asset' },
  { keyword: ['credit', 'borrow', 'loan'],                  skill: 'credit',     description: 'Performance-based credit lines — $100 to $50k based on agent track record' },
  { keyword: ['bond', 'stake', 'yield'],                    skill: 'bonds',      description: 'HiveBond staking — 3-18% APY, boosts trust score' },
  { keyword: ['stream', 'streaming', 'per-second'],         skill: 'streaming',  description: 'Per-second payment streams between agents' },
  { keyword: ['budget', 'delegation', 'policy'],            skill: 'budget',     description: 'Budget delegation — set spend limits per agent per tool' },
  { keyword: ['cashback', 'ritz', 'rewards'],               skill: 'cashback',   description: 'Ritz Cashback — 10% back on every paid API call' },
];

function routeSkill(text = '') {
  const lower = text.toLowerCase();
  for (const s of SKILLS) {
    if (s.keyword.some(k => lower.includes(k))) return s;
  }
  return null;
}

function makeTask(id, ctxId, state, textResponse, metadata = {}) {
  return {
    id,
    contextId: ctxId,
    status: {
      state,
      message: { role: 'agent', parts: [{ type: 'text', text: textResponse }] },
      timestamp: new Date().toISOString(),
    },
    artifacts: state === 'completed' ? [{
      artifactId: 'resp-' + crypto.randomBytes(4).toString('hex'),
      parts: [{ type: 'text', text: textResponse }],
    }] : undefined,
    metadata: {
      service: SERVICE_NAME,
      network: 'Hive Civilization — 24+ services',
      onboard: ONBOARD_URL,
      ...metadata,
    },
  };
}

async function handleSend(params, req) {
  const { id, message, contextId: inCtxId, metadata = {} } = params || {};
  if (!id)      return { error: { code: -32602, message: 'Missing required field: id' } };
  if (!message) return { error: { code: -32602, message: 'Missing required field: message' } };

  const tid   = id;
  const ctxId = inCtxId || contextId();
  const did   = req.headers['x-hive-did'] || req.headers['x-agent-did'] || metadata.agent_did || null;
  const text  = (message.parts || []).find(p => p.type === 'text')?.text || '';
  const skill = routeSkill(text);

  let responseText, meta = {};

  if (!did) {
    responseText =
      `This is ${SERVICE_NAME} — programmable treasury for autonomous agents. ` +
      `Register a free Hive DID at ${ONBOARD_URL} and include it as X-Hive-DID. ` +
      `First DID is free. You get a $1 USDC welcome bonus.`;
    meta = { onboard: ONBOARD_URL, welcome_bonus_usdc: 1.00 };
  } else if (skill) {
    const endpoints = {
      vault:     `${SERVICE_URL}/v1/bank/vault/${did}`,
      payment:   `${SERVICE_URL}/v1/pay`,
      wallet:    `${SERVICE_URL}/v1/wallet/${did}/card`,
      treasury:  `${SERVICE_URL}/v1/treasury/address`,
      credit:    `${SERVICE_URL}/v1/credit/status/${did}`,
      bonds:     `${SERVICE_URL}/v1/bonds/portfolio/${did}`,
      streaming: `${SERVICE_URL}/v1/bank/streams/${did}`,
      budget:    `${SERVICE_URL}/v1/bank/budget/${did}`,
      cashback:  `${SERVICE_URL}/v1/cashback/balance/${did}`,
    };
    responseText =
      `${skill.description}. Endpoint: ${endpoints[skill.skill]}. ` +
      `DID ${did} recognized on HiveBank.`;
    meta = { skill: skill.skill, endpoint: endpoints[skill.skill], agent_did: did };
  } else {
    responseText =
      `I'm ${SERVICE_NAME}. I handle: vaults, payments, MPC wallet, credit lines, bonds, streaming payments, and budget delegation. ` +
      `DID: ${did}. What do you need?`;
    meta = { skills: SKILLS.map(s => s.skill), agent_did: did };
  }

  const task = makeTask(tid, ctxId, 'completed', responseText, meta);
  TASKS.set(tid, task);
  return { result: task };
}

router.post('/', async (req, res) => {
  const { id: rpcId, method, params } = req.body || {};

  if (!method) {
    return res.status(200).json({
      jsonrpc: '2.0', id: rpcId || null,
      error: { code: -32600, message: 'Invalid Request — missing method' },
    });
  }

  try {
    let result;
    switch (method) {
      case 'message/send':
      case 'tasks/send':
        result = await handleSend(params, req);
        break;

      case 'tasks/get': {
        const task = TASKS.get(params?.id);
        result = task
          ? { result: task }
          : { error: { code: -32001, message: `Task ${params?.id} not found` } };
        break;
      }

      case 'tasks/cancel': {
        const task = TASKS.get(params?.id);
        if (task) { task.status.state = 'canceled'; task.status.timestamp = new Date().toISOString(); }
        result = task ? { result: task } : { error: { code: -32001, message: `Task ${params?.id} not found` } };
        break;
      }

      case 'tasks/resubscribe':
        result = { result: TASKS.get(params?.id) || { error: 'Task not found' } };
        break;

      case 'agent/getCard':
      case 'agent/card':
        result = { result: {
          protocolVersion: '0.2.1',
          name: SERVICE_NAME,
          description: 'Programmable treasury for autonomous agents — USDC vaults, MPC wallet, credit lines, streaming payments, HiveBonds.',
          url: SERVICE_URL,
          skills: SKILLS.map(s => ({ id: s.skill, name: s.skill, description: s.description,
            inputModes: ['application/json'], outputModes: ['application/json'] })),
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        }};
        break;

      default:
        result = { error: { code: -32601, message: `Method not found: ${method}`,
          data: { supported: ['message/send','tasks/send','tasks/get','tasks/cancel'], service: SERVICE_NAME } }};
    }

    if (result.error) return res.status(200).json({ jsonrpc: '2.0', id: rpcId, error: result.error });
    return res.status(200).json({ jsonrpc: '2.0', id: rpcId, result: result.result });

  } catch (e) {
    console.error('[A2A]', method, e.message);
    return res.status(200).json({ jsonrpc: '2.0', id: rpcId,
      error: { code: -32603, message: 'Internal error', data: e.message } });
  }
});

module.exports = router;
