/**
 * HiveBank — x402 Payment Required Middleware (USDC-ONLY)
 *
 * Doctrine: HiveBank is a treasury-as-a-service ATTESTATION layer.
 * Hive does NOT custody funds. Hive provides:
 *   - Float tracking (read-only ledger view across rails)
 *   - Treasury policy attestation ($50/policy)
 *   - Budget delegation policy enforcement ($0.10/delegation)
 *   - Payment stream setup ($0.01 flat + 0.1% of stream rate)
 *   - Credit line underwriting attestation ($1.00/application)
 *   - Yield routing attestation: 5 bps on routed yield (tracked, not custodied)
 *
 * Partner doctrine: Coinbase/Anchorage/Fireblocks hold the keys.
 * HiveBank attests to policy, tracks float, routes yields via Aave/Compound/Morpho.
 * Merchant retains custody via their wallet/MPC.
 *
 * Treasury: Monroe Base 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 * Brand gold: #C08D23
 */

const HIVE_PAYMENT_ADDRESS = (process.env.HIVE_PAYMENT_ADDRESS || '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e').toLowerCase();
const SERVICE_KEY = process.env.HIVE_INTERNAL_KEY || '';
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BASE_CHAIN_ID = 8453;

// ─── Free GET endpoints (read-only / discovery) ────────────────
const FREE_PREFIXES_GET = [
  '/health', '/', '/v1/bank/stats', '/v1/bank/vault/rates', '/v1/bank/vault/stats',
  '/v1/bonds/rates', '/v1/bonds/stats', '/v1/cashback/tiers',
  '/v1/cashback/leaderboard', '/v1/bank/referral/leaderboard',
  '/v1/bank/referral/card', '/v1/grid/rails', '/v1/grid/stats',
  '/.well-known', '/mcp',
];

// ─── Fee table ─────────────────────────────────────────────────
// Only POST/mutation endpoints are gated.
// Revenue model: attestation fees + routing fees.
// NOT charging on vault/deposit or vault/withdraw directly —
// those are agent-custody operations; HiveBank earns via yield routing (5bps).
const FEE_TABLE = {
  '/v1/bank/delegate':              { amount: 0.10,   model: 'delegation_policy',      label: 'Budget delegation policy ($0.10/rule)' },
  '/v1/bank/delegate/check':        { amount: 0.01,   model: 'delegation_check',        label: 'Budget delegation check ($0.01)' },
  '/v1/bank/stream/start':          { amount: 0.01,   model: 'stream_setup',            label: 'Payment stream setup ($0.01 flat + 0.1% of rate)' },
  '/v1/bank/stream/create':         { amount: 0.01,   model: 'stream_setup',            label: 'Payment stream setup ($0.01)' },
  '/v1/bank/vault/yield':           { amount: 0.10,   model: 'yield_attestation',       label: 'Yield routing attestation ($0.10)' },
  '/v1/bank/vault/configure-reinvest': { amount: 0.05, model: 'reinvest_policy',         label: 'Reinvestment policy config ($0.05)' },
  '/v1/bank/settle':                { amount: 0.01,   model: 'settlement_attestation',  label: 'Settlement attestation ($0.01/tx)' },
  '/v1/grid/route':                 { amount: 0.01,   model: 'routing_attestation',     label: 'Payment rail routing ($0.01)' },
  '/v1/grid/execute':               { amount: 0.02,   model: 'routing_execution',       label: 'Payment rail execution ($0.02)' },
  '/v1/credit/apply':               { amount: 1.00,   model: 'credit_underwriting',     label: 'Credit line underwriting attestation ($1.00)' },
  '/v1/bank/credit/apply':          { amount: 1.00,   model: 'credit_underwriting',     label: 'Credit line underwriting attestation ($1.00)' },
  '/v1/bank/treasury/credit':       { amount: 0.05,   model: 'treasury_credit',         label: 'Treasury credit ($0.05)' },
  '/v1/bank/graph/record':          { amount: 0.001,  model: 'graph_record',            label: 'Transaction graph record ($0.001)' },
  '/v1/bank/treasury-policy/attest': { amount: 50.00, model: 'treasury_policy',         label: 'Treasury policy attestation ($50/policy)' },
};

function getFee(path) {
  if (FEE_TABLE[path]) return FEE_TABLE[path];
  for (const [prefix, fee] of Object.entries(FEE_TABLE)) {
    if (path.startsWith(prefix)) return fee;
  }
  // Default: POST mutations cost $0.01
  return { amount: 0.01, model: 'bank_per_call', label: 'HiveBank API call ($0.01)' };
}

function isFree(path, method) {
  // All GETs on free prefixes
  if (method === 'GET') {
    for (const prefix of FREE_PREFIXES_GET) {
      if (path.startsWith(prefix)) return true;
    }
    return true; // All GETs are free (read-only)
  }
  // Vault deposit/withdraw: these are agent-custody ops, not charged (HiveBank earns yield 5bps on the routed amount)
  // They still require a valid DID (auth handles that), not x402
  if (path === '/v1/bank/vault/deposit' || path === '/v1/bank/vault/withdraw') return true;
  if (path === '/v1/bank/vault/create') return true; // vault creation is free
  if (path === '/v1/bank/vault/rebalance') return true; // internal only
  // Cashback earn/spend are free (cashback is HiveBank's loyalty loop, not a fee surface)
  if (path.startsWith('/v1/cashback')) return true;
  // Bonds staking is a separate revenue surface (hive-trust-bond handles this)
  if (path.startsWith('/v1/bonds')) return true;
  // Referral record/convert is internal
  if (path.startsWith('/v1/bank/referral')) return true;
  // Pay and A2A routes are settlement-oriented — HiveBank earns on settlement side, not per-call
  if (path.startsWith('/v1/pay') || path.startsWith('/v1/bank/settle/stealth')) return true;
  // Well-known and MCP
  if (path.startsWith('/.well-known') || path.startsWith('/mcp')) return true;
  return false;
}

// ─── Replay protection ─────────────────────────────────────────
const spentTxHashes = new Set();

// ─── On-chain USDC verification ────────────────────────────────
async function verifyOnChainPayment(txHash, requiredAmountUsdc) {
  if (!HIVE_PAYMENT_ADDRESS || HIVE_PAYMENT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return { valid: false, reason: 'Payment address not configured' };
  }
  try {
    const receiptRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
      signal: AbortSignal.timeout(10000),
    });
    const { result: receipt } = await receiptRes.json();
    if (!receipt || receipt.status !== '0x1') return { valid: false, reason: 'Transaction not found or failed on Base L2' };
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      const recipient = '0x' + log.topics[2].slice(26).toLowerCase();
      if (recipient !== HIVE_PAYMENT_ADDRESS) continue;
      const amountUsdc = parseInt(log.data, 16) / 1_000_000;
      if (amountUsdc >= requiredAmountUsdc) {
        spentTxHashes.add(txHash);
        return { valid: true, amount_usdc: amountUsdc };
      }
    }
    return { valid: false, reason: 'No sufficient USDC transfer to HiveBank treasury found' };
  } catch (e) {
    console.error('[x402] On-chain error:', e.message);
    return { valid: false, reason: 'Chain verification error — retry' };
  }
}

function x402Middleware(req, res, next) {
  if (isFree(req.path, req.method)) return next();

  const internalKey = req.headers['x-hive-internal'] || req.headers['x-api-key'];
  if (SERVICE_KEY && internalKey === SERVICE_KEY) {
    req.paymentVerified = true;
    req.paymentSource = 'internal';
    return next();
  }

  const fee = getFee(req.path);
  const paymentHash = req.headers['x-payment-hash'] || req.headers['x-402-tx'] || req.headers['x-payment-tx'];

  if (paymentHash) {
    if (spentTxHashes.has(paymentHash)) {
      return res.status(409).json({ success: false, error: 'Payment already used', code: 'PAYMENT_REPLAY' });
    }
    verifyOnChainPayment(paymentHash, fee.amount).then(result => {
      if (result.valid) {
        req.paymentVerified = true;
        req.paymentSource = 'onchain';
        req.paymentInfo = result;
        return next();
      }
      return res.status(402).json({ success: false, error: 'Payment verification failed', details: result.reason, required: fee });
    }).catch(e => {
      console.error('[x402] Error:', e.message);
      return res.status(500).json({ error: 'Payment service error' });
    });
    return;
  }

  res.set({
    'X-Payment-Amount': fee.amount.toString(),
    'X-Payment-Currency': 'USDC',
    'X-Payment-Network': 'base',
    'X-Payment-Chain-Id': BASE_CHAIN_ID.toString(),
    'X-Payment-Address': HIVE_PAYMENT_ADDRESS,
    'X-Payment-Model': fee.model,
  });

  return res.status(402).json({
    success: false,
    error: 'Payment required',
    code: 'PAYMENT_REQUIRED',
    protocol: 'x402',
    service: 'HiveBank — Treasury Policy Attestation + Routing Layer',
    payment: {
      amount_usdc: fee.amount,
      currency: 'USDC',
      network: 'base',
      chain_id: BASE_CHAIN_ID,
      recipient: HIVE_PAYMENT_ADDRESS,
      usdc_contract: USDC_CONTRACT,
      model: fee.model,
      label: fee.label,
    },
    how_to_pay: {
      step_1: `Send ${fee.amount} USDC to ${HIVE_PAYMENT_ADDRESS} on Base (chain ID ${BASE_CHAIN_ID})`,
      step_2: 'Include the transaction hash in the X-Payment-Hash header',
      step_3: 'Retry this request — payment is verified on-chain automatically',
    },
    fee_schedule: {
      delegation_policy:      '$0.10/rule — POST /v1/bank/delegate',
      yield_attestation:      '$0.10 — POST /v1/bank/vault/yield',
      stream_setup:           '$0.01 flat — POST /v1/bank/stream/create',
      credit_underwriting:    '$1.00 — POST /v1/credit/apply',
      treasury_policy:        '$50.00 — POST /v1/bank/treasury-policy/attest',
      routing_attestation:    '$0.01 — POST /v1/grid/route',
      settlement_attestation: '$0.01/tx — POST /v1/bank/settle',
    },
    doctrine: 'HiveBank is a treasury attestation + routing layer. Coinbase/Anchorage/Fireblocks hold the keys. HiveBank attests policy, tracks float, routes yield. Merchant retains custody.',
    treasury: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    brand: '#C08D23',
  });
}

module.exports = { x402Middleware, getFee, isFree };
