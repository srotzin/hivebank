/**
 * usdc-transfer.js — Real USDC transfers via Coinbase Advanced Trade API
 *
 * Uses Coinbase API (JWT auth with EC key) to send USDC from the Hive
 * Coinbase account to any external address on Base L2.
 *
 * Required env vars:
 *   COINBASE_API_KEY_NAME   — e.g. 56d481fc-f2ad-4b17-9c3a-10341afd8473
 *   COINBASE_API_SECRET     — the base64 API secret
 *   COINBASE_WALLET_SECRET  — the PEM EC private key (for JWT signing)
 *
 * Safe fallback: if env vars not set, returns {skipped: true} — DB credit
 * still applies, nothing breaks.
 */

const crypto = require('crypto');
const https  = require('https');

const API_KEY_NAME    = process.env.COINBASE_API_KEY_NAME;
const API_SECRET      = process.env.COINBASE_API_SECRET;
const WALLET_SECRET   = process.env.COINBASE_WALLET_SECRET;

const CB_HOST = 'api.coinbase.com';

// ─── Build JWT for Coinbase API auth ─────────────────────────────────────────
function buildJWT(method, path) {
  if (!API_KEY_NAME || !WALLET_SECRET) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: API_KEY_NAME })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: API_KEY_NAME,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `${method} ${CB_HOST}${path}`,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;

  // Decode the PEM wallet secret
  let pemKey = WALLET_SECRET;
  if (!pemKey.includes('-----')) {
    // Raw base64 — wrap it
    pemKey = `-----BEGIN EC PRIVATE KEY-----\n${pemKey}\n-----END EC PRIVATE KEY-----`;
  }

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const sig = sign.sign(pemKey, 'base64url');

  return `${signingInput}.${sig}`;
}

// ─── Generic Coinbase API call ────────────────────────────────────────────────
function cbRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const jwt = buildJWT(method, path);
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: CB_HOST,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Get USDC balance from Coinbase ──────────────────────────────────────────
async function checkUSDCBalance() {
  if (!API_KEY_NAME || !WALLET_SECRET) {
    return { ok: false, skipped: true, reason: 'COINBASE_API_KEY_NAME or COINBASE_WALLET_SECRET not set' };
  }

  try {
    const resp = await cbRequest('GET', '/api/v3/brokerage/accounts');
    if (resp.status !== 200) {
      return { ok: false, error: `Coinbase API error ${resp.status}`, detail: resp.body };
    }

    const accounts = resp.body.accounts || [];
    const usdc = accounts.find(a => a.currency === 'USDC');
    const balance = usdc ? parseFloat(usdc.available_balance?.value || 0) : 0;

    return {
      ok: true,
      balance_usdc: balance,
      account_uuid: usdc?.uuid || null,
      source: 'coinbase',
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Send USDC via Coinbase API ───────────────────────────────────────────────
async function sendUSDC(toAddress, amountUsdc, opts = {}) {
  if (!API_KEY_NAME || !WALLET_SECRET) {
    console.warn('[usdc-transfer] Coinbase env vars not set — transfer skipped (DB-only mode)');
    return { ok: false, skipped: true, reason: 'Coinbase API credentials not configured', amount_usdc: amountUsdc, to: toAddress };
  }

  if (!toAddress || amountUsdc <= 0) {
    return { ok: false, error: 'Invalid address or amount' };
  }

  try {
    // Get USDC account UUID
    const balResp = await checkUSDCBalance();
    if (!balResp.ok) return { ok: false, error: 'Could not fetch balance', detail: balResp };
    if (balResp.balance_usdc < amountUsdc) {
      return { ok: false, error: `Insufficient USDC: have ${balResp.balance_usdc}, need ${amountUsdc}` };
    }

    const account_uuid = balResp.account_uuid;
    if (!account_uuid) return { ok: false, error: 'USDC account not found on Coinbase' };

    // Send transaction
    const idem = `hive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const body = {
      type: 'send',
      to: toAddress,
      amount: amountUsdc.toFixed(6),
      currency: 'USDC',
      network: 'base',
      idem, // idempotency key
      description: opts.reason || 'Hive referral credit',
    };

    console.log(`[usdc-transfer] Sending ${amountUsdc} USDC → ${toAddress} via Coinbase API`);
    const resp = await cbRequest('POST', `/api/v3/brokerage/accounts/${account_uuid}/transactions`, body);

    if (resp.status === 200 || resp.status === 201) {
      const tx = resp.body.transaction || resp.body;
      console.log(`[usdc-transfer] Success — tx id: ${tx.id || tx.transaction_id}`);
      return {
        ok: true,
        tx_hash: tx.network?.hash || tx.id || idem,
        tx_id: tx.id,
        amount_usdc: amountUsdc,
        to: toAddress,
        network: 'base',
        source: 'coinbase_api',
        status: tx.status,
      };
    } else {
      console.error('[usdc-transfer] Coinbase send failed:', resp.body);
      return { ok: false, error: `Coinbase API ${resp.status}`, detail: resp.body, amount_usdc: amountUsdc, to: toAddress };
    }
  } catch (err) {
    console.error('[usdc-transfer] Exception:', err.message);
    return { ok: false, error: err.message, amount_usdc: amountUsdc, to: toAddress };
  }
}

// ─── Smoke test: send $0.01 USDC ─────────────────────────────────────────────
async function testTransfer(toAddress) {
  console.log('[usdc-transfer] Running $0.01 USDC smoke test via Coinbase API...');
  return sendUSDC(toAddress, 0.01, { reason: 'Hive smoke test' });
}

module.exports = { sendUSDC, checkUSDCBalance, testTransfer };
