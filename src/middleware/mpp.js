/**
 * HiveBank — MPP (Machine Payments Protocol) Middleware
 *
 * Runs ALONGSIDE existing x402 middleware. Either rail satisfies payment.
 * Implements IETF draft-ryan-httpauth-payment Payment header scheme.
 * MPP receipts emit Spectral receipts with payment_method: "mpp".
 *
 * Stream D — settlement, custody attestation
 * Treasury: resolved via src/lib/treasury.getTreasuryAddress() — no fallback,
 *           no lowercase, no env-or-hardcode antipattern.
 *
 * Settlement rails: USDC on Base mainnet only (chain_id 8453, contract
 * 0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913). Tempo is private testnet
 * with no public allowlist; previous Tempo claim removed 2026-04-30.
 *
 * References:
 *   https://github.com/wevm/mppx
 *   https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/
 */

'use strict';

const { getTreasuryAddress } = require('../lib/treasury');
const { canonicalAddress }   = require('../lib/canonical');

// ─── Configuration ───────────────────────────────────────────

// Lazy resolver — fail-closed via getTreasuryAddress() and canonicalAddress().
// Never lowercased, never `||` fallback to a hex literal.
function getMppPaymentAddress() {
  return canonicalAddress(getTreasuryAddress());
}

const BASE_RPC_URL  = process.env.BASE_RPC_URL  || 'https://mainnet.base.org';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RECEIPT_ENDPOINT = 'https://hive-receipt.onrender.com/v1/receipt/sign';
const BASE_CHAIN_ID = 8453;

// In-memory MPP payment cache (TTL 10 min)
const mppPaymentCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mppPaymentCache) {
    if (now - v.timestamp > 600_000) mppPaymentCache.delete(k);
  }
}, 60_000);

// ─── Spectral Receipt (non-blocking) ─────────────────────────

async function emitMppSpectralReceipt({ path, amount, txHash }) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4_000);
    await fetch(RECEIPT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        issuer_did:     'did:hive:hivebank',
        event_type:     'api_payment',
        amount_usd:     amount,
        currency:       'USDC',
        network:        'base',
        chain_id:       BASE_CHAIN_ID,
        pay_to:         getMppPaymentAddress(),
        endpoint:       path,
        tx_hash:        txHash,
        payment_method: 'mpp',
        rail:           'base-usdc',
        timestamp:      new Date().toISOString(),
      }),
    });
    clearTimeout(timer);
  } catch (_) {
    // Non-blocking — never interrupts the fee path
  }
}

// ─── On-chain USDC verification (Base mainnet only) ──────────

async function verifyMppOnChain(txHash, expectedAmount) {
  const treasury = getMppPaymentAddress().toLowerCase();
  const usdc = USDC_CONTRACT.toLowerCase();

  try {
    const rpcRes = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const { result: receipt } = await rpcRes.json();
    if (!receipt || receipt.status !== '0x1') {
      return { ok: false, reason: 'tx not confirmed or reverted on Base mainnet' };
    }
    for (const log of receipt.logs) {
      if (
        log.address?.toLowerCase() === usdc &&
        log.topics?.[0] === TRANSFER_TOPIC
      ) {
        const toAddr = '0x' + log.topics[2].slice(26).toLowerCase();
        if (toAddr === treasury) {
          const transferAmount = parseInt(log.data, 16) / 1e6;
          if (transferAmount >= expectedAmount - 0.001) {
            return { ok: true, transferAmount };
          }
          return { ok: false, reason: `insufficient: got ${transferAmount}, need ${expectedAmount}` };
        }
      }
    }
    return { ok: false, reason: 'no matching USDC Transfer to treasury found on Base' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ─── MPP Payment Header Parser ───────────────────────────────

function parseMppHeader(req) {
  const paymentHdr = req.headers['payment'] || req.headers['x-payment'] || '';
  if (paymentHdr) {
    const params = {};
    for (const part of paymentHdr.split(',')) {
      const m = part.trim().match(/^([\w-]+)="([^"]*)"$/);
      if (m) params[m[1]] = m[2];
    }
    if (params.scheme === 'mpp' || params.tx_hash) {
      // Rail is fixed to base-usdc — Tempo claim removed.
      return {
        found:   true,
        txHash:  params.tx_hash || params.credential || '',
        rail:    'base-usdc',
        amount:  parseFloat(params.amount || '0') || null,
      };
    }
  }

  const credHdr = req.headers['payment-credential'] || '';
  if (credHdr) {
    return {
      found:   true,
      txHash:  credHdr,
      rail:    'base-usdc',
      amount:  parseFloat(req.headers['x-mpp-amount'] || '0') || null,
    };
  }

  return { found: false };
}

// ─── Fee table ───────────────────────────────────────────────
// Stream D: custody & settlement

const DID_CREDENTIAL_PRICING = {
  '/v1/bank/draw/instant':  1.00,
  '/v1/bank/draw/schedule': 1.00,
  '/v1/bank/draw/credit':   1.00,
};

function getMppPrice(path) {
  if (DID_CREDENTIAL_PRICING[path]) return DID_CREDENTIAL_PRICING[path];
  if (path.startsWith('/v1/bank/custody/')) return 0.25;
  if (path.startsWith('/v1/bank/draw/'))    return 1.00;
  return 0.25; // Default bank call price
}

// ─── Free-path list ──────────────────────────────────────────

const FREE_PATHS = new Set([
  '/health', '/openapi.json', '/stats',
]);

function isFreePath(path) {
  if (FREE_PATHS.has(path)) return true;
  if (path.startsWith('/.well-known/')) return true;
  return false;
}

// ─── Main MPP Middleware ──────────────────────────────────────

async function mppMiddleware(req, res, next) {
  if (isFreePath(req.path)) return next();

  const mpp = parseMppHeader(req);
  if (!mpp.found) return next();

  const { txHash, amount: headerAmount } = mpp;
  const expectedAmount = getMppPrice(req.path);
  const amountToVerify = headerAmount || expectedAmount;

  if (mppPaymentCache.has(txHash)) {
    const cached = mppPaymentCache.get(txHash);
    if (cached.ok) {
      res.set('Payment-Receipt', `mpp:${txHash}:verified`);
      res.set('X-Hive-Payment-Rail', 'mpp');
      res.set('X-Hive-Payment-Method', 'mpp');
      return next();
    }
    return res.status(402).json({
      error: 'MPP payment verification failed (cached)',
      code:  'MPP_PAYMENT_INVALID',
      reason: cached.reason,
    });
  }

  const verification = await verifyMppOnChain(txHash, amountToVerify);
  mppPaymentCache.set(txHash, { ...verification, timestamp: Date.now() });

  if (!verification.ok) {
    return res.status(402).json({
      error:  'MPP payment verification failed',
      code:   'MPP_PAYMENT_INVALID',
      reason: verification.reason,
      hint:   'Provide a confirmed Base mainnet USDC transaction in the Payment header.',
    });
  }

  emitMppSpectralReceipt({
    path:   req.path,
    amount: amountToVerify,
    txHash,
  }).catch(() => {});

  res.set('Payment-Receipt',        `mpp:${txHash}:base-usdc`);
  res.set('X-Hive-Payment-Rail',   'mpp');
  res.set('X-Hive-Payment-Method', 'mpp');
  return next();
}

module.exports = { mppMiddleware, mppPaymentCache, getMppPaymentAddress };
