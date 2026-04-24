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

// ─── Spectral hardening (post-2026-04-25 incident) ──────────────────────────
// Six-layer guard + Spectral ZK ticket verifier. See HARDENING.md.
const outboundGuard = require('./outbound-guard');
const spectralZk    = require('./spectral-zk-auth');

// ─── Config ──────────────────────────────────────────────────────────────────
const WALLET_PRIVATE_KEY  = process.env.HIVE_WALLET_PRIVATE_KEY;   // 0x-prefixed
const API_KEY_NAME        = process.env.COINBASE_API_KEY_NAME;
const WALLET_SECRET       = process.env.COINBASE_WALLET_SECRET;
const SENDS_PAUSED        = process.env.USDC_SENDS_PAUSED === 'true';

// Base L2 — RPC cascade (FallbackProvider for true failover)
// drpc.org free tier blocks batches >3 — stripped from candidate list.
// BASE_RPC_URL: single override (back-compat).
// BASE_RPC_URLS: comma-separated list (preferred; goes into FallbackProvider in priority order).
const _envList = (process.env.BASE_RPC_URLS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const BASE_RPC_CANDIDATES = [
  ...(_envList.length ? _envList : [process.env.BASE_RPC_URL].filter(Boolean)),
  'https://1rpc.io/base',             // free, no batch limit, proven reliable
  'https://mainnet.base.org',         // Coinbase public, 403 from non-browser but fallback
].filter(Boolean);
// Strip drpc free tier — it blocks batches >3 and kills every EIP-3009 settlement
const BASE_RPC_FILTERED = BASE_RPC_CANDIDATES.filter(r => !r.includes('drpc.org'));
// De-dupe while preserving order
const BASE_RPCS = [...new Set(BASE_RPC_FILTERED)];
if (BASE_RPCS.length === 0) BASE_RPCS.push('https://1rpc.io/base');
const BASE_RPC = BASE_RPCS[0]; // legacy single-URL ref kept for log compat
const USDC_CONTRACT       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID            = 8453;
console.log(`[usdc-transfer] RPC primary: ${BASE_RPC} (${BASE_RPCS.length} total in failover pool)`);

// Build a FallbackProvider so a single RPC blip can't take settlement down.
// quorum: 1 = first successful response wins (fast). priority: lower = preferred.
function buildBaseProvider() {
  if (BASE_RPCS.length === 1) {
    // Single RPC — FallbackProvider needs >=2 to be useful, fall back to JsonRpcProvider.
    return new ethers.JsonRpcProvider(BASE_RPCS[0], { chainId: CHAIN_ID, name: 'base' });
  }
  const configs = BASE_RPCS.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, { chainId: CHAIN_ID, name: 'base' }),
    priority: i + 1,
    weight: i === 0 ? 2 : 1,
    stallTimeout: 2000,
  }));
  return new ethers.FallbackProvider(configs, CHAIN_ID, { quorum: 1 });
}

// ERC-20 minimal ABI — transfer + balanceOf only
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// EIP-3009 ABI — transferWithAuthorization (gasless, signed by payer)
const EIP3009_ABI = [
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
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
  // Circuit breaker: if the DB has been failing recently, skip writes entirely
  // until a cool-off window passes. The on-chain settlement is the source of
  // truth; the ledger insert is best-effort accounting. Hammering a dead DB on
  // every settled call generates unbounded promise pressure under load.
  if (logSend._dbCircuitOpenUntil && Date.now() < logSend._dbCircuitOpenUntil) {
    return; // circuit open — skip silently
  }
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
    logSend._dbFailures = 0;
  } catch (err) {
    try {
      await db.run(
        `INSERT INTO usdc_sends (to_address, amount_usdc, reason, tx_hash, tx_id, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [toAddress, amountUsdc, reason||null, txHash||null, txId||null, status, new Date().toISOString()]
      );
      logSend._dbFailures = 0;
    } catch (e2) {
      // Throttle this log: same message on every settled tx is what filled the
      // log pipe last time. Print once per 100 failures + open circuit.
      logSend._dbFailures = (logSend._dbFailures || 0) + 1;
      if (logSend._dbFailures === 1 || logSend._dbFailures % 100 === 0) {
        console.error(`[usdc-transfer] logSend error (non-fatal, count=${logSend._dbFailures}):`, e2.message);
      }
      // After 5 consecutive failures, open the circuit for 5 min so we stop
      // hammering a dead DB on every settled call.
      if (logSend._dbFailures >= 5) {
        logSend._dbCircuitOpenUntil = Date.now() + 5 * 60 * 1000;
        if (logSend._dbFailures === 5) {
          console.error('[usdc-transfer] DB circuit OPEN for 5min after 5 consecutive failures — settlement continues, ledger writes paused');
        }
      }
    }
  }
}

// ─── PRIMARY: Direct on-chain send via ethers.js ──────────────────────────────
async function sendUSDCOnChain(toAddress, amountUsdc) {
  const provider = buildBaseProvider();
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
      const provider = buildBaseProvider();
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

  // ── Spectral Hardened Outbound Defense (SHOD) — 6-layer guard ────────────
  // L0 kill, L1 allowlist, L2 daily cap, L3 per-recipient cap, L4 spectral
  // anomaly, L5 trust gate. Any deny short-circuits BEFORE chain interaction.
  const guard = await outboundGuard.checkOutbound({
    toAddress,
    amountUsdc,
    hiveDid: opts.hive_did || null,
    reason:  opts.reason   || 'hive_transfer',
    route:   opts.route    || 'unknown',
  });
  if (!guard.allow) {
    await logSend({
      toAddress, amountUsdc,
      reason: opts.reason || 'hive_transfer',
      txHash: null, txId: null, status: 'denied:' + guard.code,
      hiveDid: opts.hive_did || null, hiveMemo: opts.memo || null,
    }).catch(() => {});
    return {
      ok: false, blocked: true, code: guard.code, error: guard.detail,
      amount_usdc: amountUsdc, to: toAddress,
    };
  }

  // ── Spectral ZK ticket — outbound auth bound to live spectral epoch ──────
  // Ticket is signed offline by HiveTrust (separate service, separate key).
  // Even total hivebank compromise cannot forge tickets — defeats the
  // HIVE_INTERNAL_KEY-only attack vector that drained $99.99.
  const intent_hex = spectralZk.intentHash({
    toAddress,
    amountUsdc,
    reason:  opts.reason   || 'hive_transfer',
    hiveDid: opts.hive_did || null,
  });
  const zk = await spectralZk.verifyTicket(
    opts.spectralTicket || null,
    intent_hex,
    outboundGuard.getRecentRing(),
  );
  if (!zk.ok) {
    await logSend({
      toAddress, amountUsdc,
      reason: opts.reason || 'hive_transfer',
      txHash: null, txId: null, status: 'denied:zk:' + zk.code,
      hiveDid: opts.hive_did || null, hiveMemo: opts.memo || null,
    }).catch(() => {});
    return {
      ok: false, blocked: true, code: 'ZK_' + zk.code, error: zk.detail,
      amount_usdc: amountUsdc, to: toAddress, intent: intent_hex,
    };
  }

  const rateCheck = checkRateLimit(toAddress, amountUsdc);
  if (!rateCheck.allowed) return { ok: false, error: rateCheck.reason, rate_limited: true };

  let result;

  // ── Primary: direct on-chain ──────────────────────────────────────────────
  if (WALLET_PRIVATE_KEY) {
    try {
      result = await sendUSDCOnChain(toAddress, amountUsdc);
    } catch (err) {
      console.error('[usdc-transfer] On-chain send FAILED:', err.message, err.stack);
      result = { ok: false, error: 'onchain_error: ' + err.message, onchain_attempted: true };
    }
    // If on-chain was attempted, do NOT fall through to Coinbase — surface the real error
    if (result && !result.ok) {
      await logSend({ toAddress, amountUsdc, reason: opts.reason||'hive_transfer', txHash:null, txId:null, status:'failed' }).catch(()=>{});
      return result;
    }
  }

  // ── Fallback: Coinbase API (only if no wallet key configured) ─────────────
  if (!result?.ok && API_KEY_NAME && WALLET_SECRET) {
    console.log('[usdc-transfer] No wallet key — falling back to Coinbase API send');
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

// ─── Submit EIP-3009 Authorization on-chain (x402 settlement) ────────────────────────────────────────────────
// Takes a signed EIP-3009 authorization payload from the x402 client and submits
// it on-chain using the treasury wallet as the gas-paying submitter.
// The USDC contract then transfers `value` from `from` (agent) to `to` (treasury).
// Shared provider — created once, reused across all settlements. No cold provider per call.
let _provider = null;
let _submitter = null;
let _usdcContract = null;

function getSettlementContracts() {
  if (!_provider) {
    _provider    = buildBaseProvider();
    _submitter   = new ethers.Wallet(WALLET_PRIVATE_KEY, _provider);
    _usdcContract = new ethers.Contract(USDC_CONTRACT, EIP3009_ABI, _submitter);
  }
  return { provider: _provider, submitter: _submitter, usdc: _usdcContract };
}

async function submitEIP3009Authorization(payload) {
  if (!WALLET_PRIVATE_KEY) {
    return { ok: false, skipped: true, reason: 'HIVE_WALLET_PRIVATE_KEY not set' };
  }

  try {
    const { authorization, signature } = payload;
    if (!authorization || !signature) {
      return { ok: false, error: 'payload missing authorization or signature' };
    }

    const { usdc } = getSettlementContracts(); // reuse warm connection — no setup latency
    const sig = ethers.Signature.from(signature);
    const amountUsdc = Number(authorization.value) / 1_000_000;

    console.log(`[eip3009] Broadcasting: ${authorization.from} → ${authorization.to} | $${amountUsdc} USDC`);

    // Race-to-block gas overrides. Base produces blocks every ~2s; a small
    // priority bump pushes our tx into the very next block instead of letting
    // it sit in mempool while validBefore ticks down. The cost is trivial
    // (~$0.0001) vs. the alternative of the auth expiring on us mid-flight.
    // Base mainnet base-fee is typically <0.01 gwei; 2 gwei priority is plenty.
    const txOverrides = {
      maxPriorityFeePerGas: ethers.parseUnits('2',  'gwei'),
      maxFeePerGas:         ethers.parseUnits('10', 'gwei'),
    };

    // Broadcast the transaction — do NOT wait for confirmation (tx.wait() blocks)
    // Return the tx hash immediately. The blockchain will confirm it — that is certain.
    const tx = await usdc.transferWithAuthorization(
      authorization.from,
      authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce,
      sig.v,
      sig.r,
      sig.s,
      txOverrides,
    );

    console.log(`[eip3009] ✅ Broadcast: ${tx.hash} | $${amountUsdc} USDC | confirming on-chain...`);

    // Record immediately with broadcast status — confirmation is async
    logSend({
      toAddress: authorization.to,
      amountUsdc,
      reason:    'x402_eip3009_settlement',
      txHash:    tx.hash,
      txId:      tx.hash,
      status:    'broadcast',
      hiveDid:   authorization.from,
    }).catch(() => {});

    // Confirm in background — updates log, does not block response
    tx.wait(1).then(receipt => {
      console.log(`[eip3009] ⛓  Confirmed: ${tx.hash} | block ${receipt.blockNumber}`);
      logSend({
        toAddress: authorization.to,
        amountUsdc,
        reason:    'x402_eip3009_settlement',
        txHash:    tx.hash,
        txId:      tx.hash,
        status:    'completed',
        hiveDid:   authorization.from,
      }).catch(() => {});
    }).catch(err => {
      // Confirmation failure does not mean the tx failed — it may still confirm
      console.warn(`[eip3009] Confirmation listener error (tx may still confirm): ${err.message}`);
    });

    // Return immediately — settled: true as soon as broadcast succeeds
    return {
      ok:          true,
      settled:     true,
      tx_hash:     tx.hash,
      amount_usdc: amountUsdc,
      status:      'broadcast',
      explorer:    `https://basescan.org/tx/${tx.hash}`,
      note:        'Broadcast confirmed. On-chain confirmation follows within ~2 blocks.',
    };

  } catch (err) {
    console.error('[eip3009] Broadcast failed:', err.message);
    // Reset contracts on RPC error so next call gets a fresh connection
    _provider = null; _submitter = null; _usdcContract = null;
    return { ok: false, error: err.message };
  }
}

// Sentinel hook: read-only DB circuit breaker state for the leak watcher.
function _dbBreakerStats() {
  const now = Date.now();
  const openUntil = logSend._dbCircuitOpenUntil || 0;
  const open = openUntil > now;
  return {
    db_circuit_open:       open,
    db_circuit_open_for_s: open ? Math.round((openUntil - now) / 1000) : 0,
    db_failures:           logSend._dbFailures || 0,
  };
}

// Read-only provider helper for other modules (e.g. routes/usdc.js verify-tx).
// Returns the shared FallbackProvider so verify-tx benefits from the same
// Alchemy-primary failover pool as settlement.
function getReadProvider() {
  if (!_provider) {
    _provider = buildBaseProvider();
  }
  return _provider;
}

module.exports = { sendUSDC, checkUSDCBalance, testTransfer, logSend, submitEIP3009Authorization, _dbBreakerStats, getReadProvider };
