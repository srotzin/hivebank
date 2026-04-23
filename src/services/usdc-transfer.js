/**
 * usdc-transfer.js — USDC transfers via direct on-chain (Base L2) + Coinbase fallback
 *
 * Primary path: ethers.js wallet signs and broadcasts directly to Base L2 USDC contract.
 *   No Coinbase dependency, no KYC gate, no minimum send restrictions.
 *
 * Fallback path: Coinbase Advanced Trade API (used if HIVE_WALLET_PRIVATE_KEY not set).
 *
 * Required env vars (primary path):
 *   HIVE_WALLET_PRIVATE_KEY  — 0x-prefixed private key for treasury wallet
 *
 * Optional env vars (fallback path):
 *   COINBASE_API_KEY_NAME    — organizations/xxx/apiKeys/xxx
 *   COINBASE_WALLET_SECRET   — EC PRIVATE KEY PEM
 *
 * Safe fallback: if neither is set, returns {skipped: true} — DB credit still applies.
 */

'use strict';

const crypto  = require('crypto');
const https   = require('https');
const { ethers } = require('ethers');
const db      = require('./db');

// ─── Config ──────────────────────────────────────────────────────────────────
const WALLET_PRIVATE_KEY  = process.env.HIVE_WALLET_PRIVATE_KEY;   // 0x-prefixed
const API_KEY_NAME        = process.env.COINBASE_API_KEY_NAME;
const WALLET_SECRET       = process.env.COINBASE_WALLET_SECRET;
const SENDS_PAUSED        = process.env.USDC_SENDS_PAUSED === 'true';

// Base L2
const BASE_RPC            = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_CONTRACT       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID            = 8453;

// ERC-20 minimal ABI — transfer + balanceOf only
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const MAX_PER_ADDRESS_PER_HOUR = 10.00;
const MAX_TOTAL_PER_HOUR = 50.00;
const sendLedger = new Map();
let hourlyTotal = 0;
let hourlyWindowStart = Date.now();

function checkRateLimit(toAddress, amount) {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000;
  if (now - hourlyWindowStart > oneHour) {
    hourlyTotal = 0;
    hourlyWindowStart = now;
    sendLedger.clear();
  }
  const addrRecord = sendLedger.get(toAddress) || { total: 0, window_start: now };
  if (now - addrRecord.window_start > oneHour) { addrRecord.total = 0; addrRecord.window_start = now; }
  if (addrRecord.total + amount > MAX_PER_ADDRESS_PER_HOUR)
    return { allowed: false, reason: `Rate limit: max $${MAX_PER_ADDRESS_PER_HOUR} USDC/hour per address` };
  if (hourlyTotal + amount > MAX_TOTAL_PER_HOUR)
    return { allowed: false, reason: `Rate limit: max $${MAX_TOTAL_PER_HOUR} USDC/hour total` };
  return { allowed: true, addrRecord };
}

function recordSend(toAddress, amount, addrRecord) {
  addrRecord.total += amount;
  sendLedger.set(toAddress, addrRecord);
  hourlyTotal += amount;
}

// ─── Audit log ────────────────────────────────────────────────────────────────
async function logSend({ toAddress, amountUsdc, reason, txHash, txId, status, referralId = null, hiveDid = null, hiveMemo = null }) {
  try {
    const now = new Date().toISOString();
    const dna = {
      hive_network: 'Hive Civilization — 31 services',
      hive_did: hiveDid,
      hive_to_wallet: toAddress,
      hive_amount_usd: amountUsdc,
      hive_reason: reason,
      hive_memo: hiveMemo || `Hive sent you $${amountUsdc}. Claim your agent DID: https://hivegate.onrender.com/v1/gate/onboard`,
      hive_timestamp: now,
    };
    await db.run(
      `INSERT INTO usdc_sends (to_address, amount_usdc, amount_usd, reason, tx_hash, tx_id, status, created_at, referral_id, did, wallet_address, memo, dna)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [toAddress, amountUsdc, amountUsdc, reason||null, txHash||null, txId||null, status, now,
       referralId, hiveDid||null, toAddress, hiveMemo||dna.hive_memo, JSON.stringify(dna)]
    );
  } catch (err) {
    try {
      await db.run(
        `INSERT INTO usdc_sends (to_address, amount_usdc, reason, tx_hash, tx_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [toAddress, amountUsdc, reason||null, txHash||null, txId||null, status, new Date().toISOString()]
      );
    } catch (e2) {
      console.error('[usdc-transfer] logSend error (non-fatal):', e2.message);
    }
  }
}

// ─── PRIMARY: Direct on-chain send via ethers.js ──────────────────────────────
async function sendUSDCOnChain(toAddress, amountUsdc) {
  const provider = new ethers.JsonRpcProvider(BASE_RPC, { chainId: CHAIN_ID, name: 'base' });
  const wallet   = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
  const usdc     = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, wallet);

  // Check balance
  const decimals = await usdc.decimals();
  const balance  = await usdc.balanceOf(wallet.address);
  const balanceHuman = parseFloat(ethers.formatUnits(balance, decimals));

  if (balanceHuman < amountUsdc) {
    return { ok: false, error: `Insufficient USDC: wallet has ${balanceHuman.toFixed(6)}, need ${amountUsdc}` };
  }

  const amount = ethers.parseUnits(amountUsdc.toFixed(6), decimals);
  console.log(`[usdc-transfer/onchain] Sending ${amountUsdc} USDC → ${toAddress} from ${wallet.address}`);

  const tx = await usdc.transfer(toAddress, amount);
  console.log(`[usdc-transfer/onchain] Broadcast tx: ${tx.hash}`);

  const receipt = await tx.wait(1);
  console.log(`[usdc-transfer/onchain] Confirmed in block ${receipt.blockNumber}`);

  return {
    ok: true,
    tx_hash: tx.hash,
    block: receipt.blockNumber,
    amount_usdc: amountUsdc,
    to: toAddress,
    from: wallet.address,
    network: 'base',
    source: 'onchain_direct',
    explorer: `https://basescan.org/tx/${tx.hash}`,
  };
}

// ─── FALLBACK: Coinbase API send ──────────────────────────────────────────────
const CB_HOST = 'api.coinbase.com';

function buildJWT(method, path) {
  if (!API_KEY_NAME || !WALLET_SECRET) return null;
  const now   = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const header  = Buffer.from(JSON.stringify({ alg: 'ES256', kid: API_KEY_NAME, nonce })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: API_KEY_NAME, iss: 'cdp', nbf: now, exp: now + 120,
    uri: `${method} ${CB_HOST}${path}`,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  let pemKey = WALLET_SECRET.replace(/\\n/g, '\n');
  if (!pemKey.includes('-----BEGIN')) pemKey = `-----BEGIN EC PRIVATE KEY-----\n${pemKey}\n-----END EC PRIVATE KEY-----`;
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  const sig = sign.sign({ key: pemKey, format: 'pem', type: 'sec1', dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${signingInput}.${sig}`;
}

function cbRequest(method, path, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const jwt     = buildJWT(method, path);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: CB_HOST, path, method,
      headers: { 'Authorization': `Bearer ${jwt}`, 'Content-Type': 'application/json', 'Accept': 'application/json', ...extraHeaders },
    };
    if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sendUSDCCoinbase(toAddress, amountUsdc, opts = {}) {
  const balResp = await checkUSDCBalance();
  if (!balResp.ok) return { ok: false, error: 'Could not fetch Coinbase balance', detail: balResp };
  if (balResp.balance_usdc < amountUsdc) return { ok: false, error: `Insufficient Coinbase USDC: have ${balResp.balance_usdc}, need ${amountUsdc}` };
  const account_uuid = balResp.account_uuid;
  if (!account_uuid) return { ok: false, error: 'USDC account not found on Coinbase' };
  const sendAmount = Math.max(amountUsdc, 1.00);
  const body = { type: 'send', to: toAddress, amount: sendAmount.toFixed(2), currency: 'USDC', network: 'base', description: opts.memo || `Hive payment ${sendAmount} USDC` };
  console.log(`[usdc-transfer/coinbase] Sending ${sendAmount} USDC → ${toAddress}`);
  const resp = await cbRequest('POST', `/v2/accounts/${account_uuid}/transactions`, body, { 'CB-VERSION': '2016-02-18' });
  if (resp.status === 200 || resp.status === 201) {
    const tx = resp.body.data || resp.body;
    return { ok: true, tx_hash: tx.network?.hash || tx.id, tx_id: tx.id, amount_usdc: sendAmount, to: toAddress, network: 'base', source: 'coinbase_api', status: tx.status };
  }
  return { ok: false, error: `Coinbase API ${resp.status}`, detail: resp.body };
}

// ─── Check USDC balance ───────────────────────────────────────────────────────
async function checkUSDCBalance() {
  // Primary: check on-chain wallet balance
  if (WALLET_PRIVATE_KEY) {
    try {
      const provider = new ethers.JsonRpcProvider(BASE_RPC, { chainId: CHAIN_ID, name: 'base' });
      const wallet   = new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
      const usdc     = new ethers.Contract(USDC_CONTRACT, ERC20_ABI, provider);
      const decimals = await usdc.decimals();
      const balance  = await usdc.balanceOf(wallet.address);
      return {
        ok: true,
        balance_usdc: parseFloat(ethers.formatUnits(balance, decimals)),
        address: wallet.address,
        source: 'onchain_base',
        network: 'base',
        explorer: `https://basescan.org/address/${wallet.address}`,
      };
    } catch (err) {
      console.warn('[usdc-transfer] On-chain balance check failed, trying Coinbase:', err.message);
    }
  }
  // Fallback: Coinbase balance
  if (!API_KEY_NAME || !WALLET_SECRET) {
    return { ok: false, skipped: true, reason: 'No HIVE_WALLET_PRIVATE_KEY or Coinbase credentials set' };
  }
  try {
    const resp = await cbRequest('GET', '/api/v3/brokerage/accounts');
    if (resp.status !== 200) return { ok: false, error: `Coinbase API error ${resp.status}`, detail: resp.body };
    const accounts = resp.body.accounts || [];
    const usdc     = accounts.find(a => a.currency === 'USDC');
    const balance  = usdc ? parseFloat(usdc.available_balance?.value || 0) : 0;
    return { ok: true, balance_usdc: balance, account_uuid: usdc?.uuid || null, source: 'coinbase' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Main sendUSDC — tries on-chain first, Coinbase fallback ─────────────────
async function sendUSDC(toAddress, amountUsdc, opts = {}) {
  if (SENDS_PAUSED) {
    return { ok: false, skipped: true, paused: true, reason: 'USDC_SENDS_PAUSED=true', amount_usdc: amountUsdc, to: toAddress };
  }
  if (!toAddress || amountUsdc <= 0) return { ok: false, error: 'Invalid address or amount' };

  const rateCheck = checkRateLimit(toAddress, amountUsdc);
  if (!rateCheck.allowed) return { ok: false, error: rateCheck.reason, rate_limited: true };

  let result;

  // ── Primary: direct on-chain ──────────────────────────────────────────────
  if (WALLET_PRIVATE_KEY) {
    try {
      result = await sendUSDCOnChain(toAddress, amountUsdc);
    } catch (err) {
      console.warn('[usdc-transfer] On-chain send failed, trying Coinbase fallback:', err.message);
      result = { ok: false, error: err.message };
    }
  }

  // ── Fallback: Coinbase API ────────────────────────────────────────────────
  if (!result?.ok && API_KEY_NAME && WALLET_SECRET) {
    console.log('[usdc-transfer] Falling back to Coinbase API send');
    try {
      result = await sendUSDCCoinbase(toAddress, amountUsdc, opts);
    } catch (err) {
      result = { ok: false, error: err.message };
    }
  }

  if (!result) {
    result = { ok: false, skipped: true, reason: 'No transfer credentials configured', amount_usdc: amountUsdc, to: toAddress };
  }

  // Audit log
  await logSend({
    toAddress, amountUsdc,
    reason: opts.reason || 'hive_transfer',
    txHash: result.tx_hash || null,
    txId: result.tx_id || null,
    status: result.ok ? 'completed' : 'failed',
    referralId: opts.referral_id || null,
    hiveDid: opts.hive_did || null,
    hiveMemo: opts.memo || null,
  });

  if (result.ok) recordSend(toAddress, amountUsdc, rateCheck.addrRecord);
  return result;
}

// ─── Smoke test ───────────────────────────────────────────────────────────────
async function testTransfer(toAddress) {
  console.log('[usdc-transfer] Running $1 USDC smoke test via on-chain direct...');
  return sendUSDC(toAddress, 1.00, { reason: 'smoke_test' });
}

module.exports = { sendUSDC, checkUSDCBalance, testTransfer, logSend };
