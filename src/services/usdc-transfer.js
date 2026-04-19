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
const db     = require('./db');

const API_KEY_NAME    = process.env.COINBASE_API_KEY_NAME;  // organizations/xxx/apiKeys/xxx format
const WALLET_SECRET   = process.env.COINBASE_WALLET_SECRET;  // EC PRIVATE KEY PEM

// ─── Emergency circuit breaker ────────────────────────────────────────────────
// Set USDC_SENDS_PAUSED=true in Render env to halt all live USDC transfers
// while persistent DB is being wired up. Remove env var to re-enable.
const SENDS_PAUSED = process.env.USDC_SENDS_PAUSED === 'true';

const CB_HOST = 'api.coinbase.com';

// ─── Hive DNA — embedded in every outgoing payment ─────────────────────────
// Every $1 we send carries our identity, DID, and network URL.
// Recipient sees this in their Coinbase transaction detail — permanently.
const HIVE_DNA = {
  did: 'did:hive:hiveforce-ambassador',
  network: 'Hive Civilization — 21 services',
  url: 'https://www.thehiveryiq.com',
  onboard: 'https://hivegate.onrender.com/v1/gate/onboard',
};

function buildMemo(opts = {}) {
  const parts = [
    opts.reason || 'Hive referral credit',
    HIVE_DNA.did,
    HIVE_DNA.url,
  ];
  if (opts.referral_id) parts.push(`ref:${opts.referral_id}`);
  // Coinbase description field max ~100 chars — keep it tight
  return parts.join(' | ').slice(0, 100);
}

// ─── Circuit breaker — rate limit sends per address ───────────────────────
// Max $10 USDC per address per hour, max $50 total per hour across all addresses
const MAX_PER_ADDRESS_PER_HOUR = 10.00;
const MAX_TOTAL_PER_HOUR = 50.00;
const sendLedger = new Map(); // address → { total, window_start }
let hourlyTotal = 0;
let hourlyWindowStart = Date.now();

function checkRateLimit(toAddress, amount) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;

  // Reset hourly window
  if (now - hourlyWindowStart > oneHour) {
    hourlyTotal = 0;
    hourlyWindowStart = now;
    sendLedger.clear();
  }

  // Check per-address limit
  const addrRecord = sendLedger.get(toAddress) || { total: 0, window_start: now };
  if (now - addrRecord.window_start > oneHour) {
    addrRecord.total = 0;
    addrRecord.window_start = now;
  }
  if (addrRecord.total + amount > MAX_PER_ADDRESS_PER_HOUR) {
    return { allowed: false, reason: `Rate limit: max $${MAX_PER_ADDRESS_PER_HOUR} USDC/hour per address` };
  }

  // Check global hourly limit
  if (hourlyTotal + amount > MAX_TOTAL_PER_HOUR) {
    return { allowed: false, reason: `Rate limit: max $${MAX_TOTAL_PER_HOUR} USDC/hour total` };
  }

  return { allowed: true, addrRecord };
}

function recordSend(toAddress, amount, addrRecord) {
  addrRecord.total += amount;
  sendLedger.set(toAddress, addrRecord);
  hourlyTotal += amount;
}

// ─── Persist send audit record to usdc_sends table ────────────────────────────────────
async function logSend({ toAddress, amountUsdc, reason, txHash, txId, status, referralId = null }) {
  try {
    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO usdc_sends (to_address, amount_usdc, reason, tx_hash, tx_id, status, created_at, referral_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [toAddress, amountUsdc, reason || null, txHash || null, txId || null, status, now, referralId]
    );
  } catch (err) {
    // Never let audit logging block the caller
    console.error('[usdc-transfer] logSend error (non-fatal):', err.message);
  }
}

// ─── Build JWT for Coinbase Advanced API (ES256 / EC key) ───────────────────
function buildJWT(method, path) {
  if (!API_KEY_NAME || !WALLET_SECRET) return null;

  const now = Math.floor(Date.now() / 1000);
  // Nonce: 16 random hex chars
  const nonce = crypto.randomBytes(8).toString('hex');

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: API_KEY_NAME, nonce })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: API_KEY_NAME,
    iss: 'cdp',
    nbf: now,
    exp: now + 120,
    uri: `${method} ${CB_HOST}${path}`,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;

  // Normalize PEM — handle escaped newlines from env vars
  let pemKey = WALLET_SECRET.replace(/\\n/g, '\n');
  if (!pemKey.includes('-----BEGIN')) {
    pemKey = `-----BEGIN EC PRIVATE KEY-----\n${pemKey}\n-----END EC PRIVATE KEY-----`;
  }

  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const sig = sign.sign({ key: pemKey, format: 'pem', type: 'sec1', dsaEncoding: 'ieee-p1363' }, 'base64url');

  return `${signingInput}.${sig}`;
}

// ─── Generic Coinbase API call ────────────────────────────────────────────────
function cbRequest(method, path, body = null, extraHeaders = {}) {
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
        'Accept': 'application/json', ...extraHeaders,
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
  if (SENDS_PAUSED) {
    console.warn('[usdc-transfer] PAUSED — USDC_SENDS_PAUSED=true. Transfer queued but not sent:', toAddress, amountUsdc);
    return { ok: false, skipped: true, paused: true, reason: 'USDC sends paused — persistent DB migration in progress. Payment will be honoured once DB is live.', amount_usdc: amountUsdc, to: toAddress };
  }

  if (!API_KEY_NAME || !WALLET_SECRET) {
    console.warn('[usdc-transfer] Coinbase env vars not set — transfer skipped (DB-only mode)');
    return { ok: false, skipped: true, reason: 'Coinbase API credentials not configured', amount_usdc: amountUsdc, to: toAddress };
  }

  if (!toAddress || amountUsdc <= 0) {
    return { ok: false, error: 'Invalid address or amount' };
  }

  // Rate limit check
  const rateCheck = checkRateLimit(toAddress, amountUsdc);
  if (!rateCheck.allowed) {
    console.warn(`[usdc-transfer] Rate limit blocked: ${toAddress} ${amountUsdc} USDC — ${rateCheck.reason}`);
    return { ok: false, error: rateCheck.reason, rate_limited: true };
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

    // Coinbase minimum send is 1 USDC
    const sendAmount = Math.max(amountUsdc, 1.00);

    // Send via Coinbase v2 API
    const body = {
      type: 'send',
      to: toAddress,
      amount: sendAmount.toFixed(2),
      currency: 'USDC',
      network: 'base',
      description: opts.idem || buildMemo(opts),
    };

    console.log(`[usdc-transfer] Sending ${sendAmount} USDC → ${toAddress} via Coinbase API`);
    const resp = await cbRequest('POST', `/v2/accounts/${account_uuid}/transactions`, body, { 'CB-VERSION': '2016-02-18' });

    if (resp.status === 200 || resp.status === 201) {
      const tx = resp.body.data || resp.body;
      const txHash = tx.network?.hash || tx.id;
      console.log(`[usdc-transfer] Success — tx id: ${tx.id}`);
      recordSend(toAddress, sendAmount, rateCheck.addrRecord);
      // Persist audit record
      await logSend({
        toAddress,
        amountUsdc: sendAmount,
        reason: opts.reason || 'Hive referral credit',
        txHash,
        txId: tx.id,
        status: 'completed',
        referralId: opts.referral_id || null
      });
      return {
        ok: true,
        tx_hash: txHash,
        tx_id: tx.id,
        amount_usdc: sendAmount,
        to: toAddress,
        network: 'base',
        source: 'coinbase_api',
        status: tx.status,
      };
    } else {
      console.error('[usdc-transfer] Coinbase send failed:', resp.body);
      // Persist failed audit record
      await logSend({
        toAddress,
        amountUsdc: sendAmount,
        reason: opts.reason || null,
        txHash: null,
        txId: null,
        status: 'failed',
        referralId: opts.referral_id || null
      });
      return { ok: false, error: `Coinbase API ${resp.status}`, detail: resp.body, amount_usdc: sendAmount, to: toAddress };
    }
  } catch (err) {
    console.error('[usdc-transfer] Exception:', err.message);
    // Persist failed audit record (best-effort)
    await logSend({
      toAddress,
      amountUsdc: amountUsdc,
      reason: opts.reason || null,
      txHash: null,
      txId: null,
      status: 'failed',
      referralId: opts.referral_id || null
    }).catch(() => {});
    return { ok: false, error: err.message, amount_usdc: amountUsdc, to: toAddress };
  }
}

// ─── Smoke test: send $0.01 USDC ─────────────────────────────────────────────
async function testTransfer(toAddress) {
  console.log('[usdc-transfer] Running $0.01 USDC smoke test via Coinbase API...');
  return sendUSDC(toAddress, 0.01, { reason: 'Hive smoke test' });
}

module.exports = { sendUSDC, checkUSDCBalance, testTransfer, logSend };
