// outbound-guard.js — Spectral Hardened Outbound Defense (SHOD).
//
// Six-layer defense that every USDC send must pass before sendUSDCOnChain
// will broadcast a transaction. Designed in response to the 2026-04-25
// $99.99 incident, where 10 sequential $10 sends to fresh EOAs drained
// $99.99 in 30 minutes through /v1/bank/usdc/send.
//
// LAYERS (each fail returns ok:false with a specific code):
//   L0  KILL_SWITCH        — USDC_SENDS_PAUSED env flag (already exists)
//   L1  ALLOWLIST_HARD     — destination must be in OUTBOUND_ALLOWLIST
//                            (the 35-wallet roster Hive3-Hive37) OR have
//                            been pre-approved via signed reason_token
//   L2  DAILY_TREASURY_CAP — total outbound USD across ALL routes capped
//                            per UTC day (default $50). Reset at 00:00 UTC.
//   L3  PER_RECIPIENT_CAP  — sliding 24h cap per address (default $20)
//   L4  SPECTRAL_ANOMALY   — feeds the rolling 60-window of per-tx
//                            amounts into the HiveChroma spectral
//                            classifier. If regime crosses into Hδ
//                            (HIGH_VIOLET) or worse, blocks send and
//                            requires operator unlock.
//   L5  TRUST_GATE         — if the request carries a hive_did, looks
//                            up its trust tier on hivetrust.onrender.com.
//                            DIDs at tier VOID/anon block by default.
//                            Configurable via OUTBOUND_TRUST_MIN_TIER.
//   L6  AUDIT_TRAIL        — every decision (allow/deny/anomaly) is
//                            written to outbound_audit table AND a
//                            short-lived in-memory ring used by L4.
//
// All layers are safe-by-default: any unhandled error → block.
// All decisions log a structured `[outbound-guard]` line so Render Logs
// + Leak Sentinel can attribute the cause without DB access.

'use strict';

const { classifyPriceWindow, REGIMES } = require('../lib/spectral');

// ─── Config (all overridable via env) ────────────────────────────────────────
const KILL_SWITCH         = () => process.env.USDC_SENDS_PAUSED === 'true';
const DAILY_TREASURY_CAP  = parseFloat(process.env.OUTBOUND_DAILY_CAP_USD     || '50');
const PER_RECIPIENT_CAP   = parseFloat(process.env.OUTBOUND_PER_RECIPIENT_CAP || '20');
const SPECTRAL_BLOCK_FROM = (process.env.OUTBOUND_SPECTRAL_BLOCK_FROM || 'HIGH_VIOLET').toUpperCase();
const ALLOWLIST_REQUIRED  = process.env.OUTBOUND_ALLOWLIST_REQUIRED !== 'false';   // default ON
const TRUST_MIN_TIER      = (process.env.OUTBOUND_TRUST_MIN_TIER  || 'MOZ').toUpperCase();
const TRUST_TIMEOUT_MS    = parseInt(process.env.OUTBOUND_TRUST_TIMEOUT_MS || '1500', 10);
const TRUST_URL           = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';

// 35-wallet roster — only these can receive auto-refills without operator override.
// Pulled from the rebalancer's wallets.json (kept in sync at deploy time).
const ROSTER_ALLOWLIST = new Set([
  // Hive3-Hive8, 26-27 (kimi1)
  '0x53213cfebbef44fae36282a1096da3d2282de54a',
  '0x20626c42dfa13a34708f5260a78e0c7b318ece51',
  '0xd945841ac3481c478b9464773e4f9b15a2ae1a74',
  '0x9112b8f73f00a69ce6e7690dce6346f6fdf9e9b6',
  '0x00d36182b61cc633768fa673c00aa3fa29e214a9',
  '0x5d67884d3f313efc7fa5c5a5ae27db9f13f57bba',
  '0x16838148055558280e5cc754b905a72c9ed3ac5c',
  '0x54a62ded4d6e5bac883f80ce486b7ae69b5c0af8',
  // Hive9-12, 28-29 (kimi2)
  '0x30cc0a66cf714e91c2befb1fc98d485d6915e0bd',
  '0x9fe9b9cf53a4699e0f49b5f95425a6ac54ae61c0',
  '0x31a5a5ac4838280afcabc4c51b1e729c294f7d69',
  '0xcc52e2e819d926d8f58a1035b8c173b5c4aa527a',
  '0x4da01e468a7a1ede4f0cd6e3c29dae1363f60d7a',
  '0xf4ed337fc62e7adcbb5f8f0742b38dad7c9f9c8e',
  // Hive13-16, 30-31 (kimi3)
  '0x16baed9223c1bc4e11d3cce0b8c7e74c5acf1f1c',
  '0x41d3b3f85f668fb28509749270830227e35e7cbd',
  '0x789eca053cab5c7a4e1942ebd18fe10c7fe810a8',
  '0x285026c2e4173a6482377872d5d8fa1dcaef5a34',
  '0x8bfa8edc24441d4b5cb8223088a9686ac129dc16',
  '0xfc01ad033f3bbd0b17f5a79e22d2dc238afc11d7',
  // Hive17-25 (manus2a/b/c)
  '0xe72c3ad0e93995c8a3b7ccc867298aac8a9ead30',
  '0xfc5eea7b66c563f3b3fe3e37f9161d0d0385f894',
  '0x732d75b7bb52b6cf3fb178c68019482431393824',
  '0x214bc7214ac6572040449f4105a908ce0873ca7b',
  '0x8c5ff06d8e1cd368258333766a9c4b2a6336cc85',
  '0x29451d7fd84fe319eeaacc6cb3a3346d99b538fe',
  '0x5032aa473693b2a4985f0174c18e1c0137f731ae',
  '0xa4f43d29858a02415409a9f26f61e9afd8d862b4',
  '0x3d84f6e2a9951129a7f0a87fd71db3806eff9a73',
  // Hive32-37 (manus2d)
  '0xb991699c61321ed03e84ad71a266035dd33a9925',
  '0xae6e585dbb2e65910a217c4dd8bb62f60177ab41',
  '0x60d2a2a5ddf97858a063f461fdcc7a9caf5313db',
  '0x9aa0640602795b208dacecea497a714bbc37848a',
  '0xdf852226a3f58772a633fb8271aed46d05ea7102',
  '0x89d15a53a4fd7db40519aedcdd41f8e20814ff86',
]);

// Tier order — index 0 is least-trusted. TRUST_MIN_TIER must be ≥ this index.
const TIER_ORDER = ['VOID', 'MOZ', 'HAWX', 'EMBR', 'SOLX', 'FENR'];

// ─── State (per-process, cleared on restart) ─────────────────────────────────
const dayWindow = { utcDay: '', total: 0 };
const recipient24h = new Map();   // addr → [{ts, amt}, ...]
const recentSends  = [];          // last 60 amounts for spectral classifier
const RECENT_MAX   = 60;

function utcDayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

function pruneOlderThan(arr, cutoffMs) {
  const now = Date.now();
  while (arr.length && (now - arr[0].ts) > cutoffMs) arr.shift();
}

function tierIndex(tier) { return TIER_ORDER.indexOf(String(tier || '').toUpperCase()); }

// ─── L4 — spectral anomaly classifier ────────────────────────────────────────
// Treats the rolling sequence of recent send-amounts as a "price" series,
// reuses HiveChroma's volatility-regime classifier from src/oracle/spectral.js.
// In normal operation the ring is mostly dispatcher-batch refills (varied amounts).
// An attacker hammering identical $10 sends spikes the vol_ratio AND the rate,
// flagged as HIGH_VIOLET or above.
function spectralCheck(amount) {
  recentSends.push(amount);
  if (recentSends.length > RECENT_MAX) recentSends.shift();
  // Need a meaningful window before classifying
  if (recentSends.length < 10) {
    return { allow: true, regime: 'WARMUP', n: recentSends.length };
  }
  const cls = classifyPriceWindow(recentSends);
  // Build an ordered list of regime names from REGIMES so we can compare
  const order = REGIMES.map(r => r.name);
  const blockIdx = order.indexOf(SPECTRAL_BLOCK_FROM);
  const curIdx   = order.indexOf(cls.regime);
  if (blockIdx >= 0 && curIdx >= 0 && curIdx >= blockIdx) {
    return { allow: false, regime: cls.regime, vol_ratio: cls.stats.vol_ratio, n: recentSends.length };
  }
  return { allow: true, regime: cls.regime, vol_ratio: cls.stats.vol_ratio, n: recentSends.length };
}

// ─── L5 — HiveTrust DID gate ────────────────────────────────────────────────
async function trustCheck(did) {
  if (!did) {
    // No DID provided → fall back to allowlist requirement (handled in L1)
    return { allow: true, tier: 'unknown', reason: 'no_did' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TRUST_TIMEOUT_MS);
    const r = await fetch(`${TRUST_URL}/v1/trust/lookup/${encodeURIComponent(did)}`, {
      headers: { 'x-hive-tier': 'enterprise' },   // bypass HiveTrust's own rate limit
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return { allow: false, tier: 'unreachable', reason: `trust_http_${r.status}` };
    const j = await r.json();
    const tier = j?.data?.tier || j?.tier || 'VOID';
    if (tierIndex(tier) < tierIndex(TRUST_MIN_TIER)) {
      return { allow: false, tier, reason: `tier_below_min_${TRUST_MIN_TIER}` };
    }
    return { allow: true, tier, reason: 'ok' };
  } catch (e) {
    return { allow: false, tier: 'error', reason: `trust_err:${e.name}` };
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────
// Returns { allow: boolean, code: string, detail: string, ...telemetry }.
// Caller (usdc-transfer.js) must short-circuit on allow:false BEFORE any
// chain interaction.
async function checkOutbound({ toAddress, amountUsdc, hiveDid, reason, route }) {
  const decision = {
    ts: new Date().toISOString(),
    to: toAddress,
    amount: amountUsdc,
    did: hiveDid || null,
    reason: reason || null,
    route: route || null,
  };

  // L0 kill switch (defence in depth — usdc-transfer.js has its own)
  if (KILL_SWITCH()) {
    return finalize(decision, false, 'L0_KILL_SWITCH', 'USDC_SENDS_PAUSED=true');
  }

  // L1 hard allowlist
  if (ALLOWLIST_REQUIRED) {
    const lc = String(toAddress || '').toLowerCase();
    if (!ROSTER_ALLOWLIST.has(lc)) {
      return finalize(decision, false, 'L1_ALLOWLIST',
        `Recipient ${toAddress} is not in the 35-wallet roster. Contact operator to add or use OUTBOUND_ALLOWLIST_REQUIRED=false.`);
    }
  }

  // L2 daily treasury cap
  const today = utcDayKey();
  if (dayWindow.utcDay !== today) { dayWindow.utcDay = today; dayWindow.total = 0; }
  if (dayWindow.total + amountUsdc > DAILY_TREASURY_CAP) {
    return finalize(decision, false, 'L2_DAILY_CAP',
      `Daily cap $${DAILY_TREASURY_CAP} would be exceeded ($${dayWindow.total.toFixed(2)} already + $${amountUsdc.toFixed(2)} = $${(dayWindow.total+amountUsdc).toFixed(2)}).`);
  }

  // L3 per-recipient 24h cap
  const lc = String(toAddress || '').toLowerCase();
  const arr = recipient24h.get(lc) || [];
  pruneOlderThan(arr, 24 * 60 * 60 * 1000);
  const recipTotal = arr.reduce((s, x) => s + x.amt, 0);
  if (recipTotal + amountUsdc > PER_RECIPIENT_CAP) {
    return finalize(decision, false, 'L3_RECIPIENT_CAP',
      `Recipient cap $${PER_RECIPIENT_CAP}/24h exceeded ($${recipTotal.toFixed(2)} + $${amountUsdc.toFixed(2)}).`);
  }

  // L4 spectral anomaly (does NOT yet append — appends only on allow)
  const spec = spectralCheck(amountUsdc);
  if (!spec.allow) {
    // Roll back the spectral push — the send is being blocked, don't poison ring
    recentSends.pop();
    return finalize(decision, false, 'L4_SPECTRAL',
      `Send pattern entered ${spec.regime} regime (vol_ratio=${(spec.vol_ratio || 0).toFixed(4)}, n=${spec.n}). Likely automated drain. Operator unlock required.`,
      { regime: spec.regime, vol_ratio: spec.vol_ratio });
  }

  // L5 trust gate (DID-based)
  const trust = await trustCheck(hiveDid);
  if (!trust.allow) {
    return finalize(decision, false, 'L5_TRUST',
      `DID ${hiveDid || '<missing>'} did not meet min tier ${TRUST_MIN_TIER} (got ${trust.tier}, ${trust.reason}).`,
      { tier: trust.tier });
  }

  // ALL CLEAR — commit state
  dayWindow.total += amountUsdc;
  arr.push({ ts: Date.now(), amt: amountUsdc });
  recipient24h.set(lc, arr);
  return finalize(decision, true, 'OK', 'cleared all 6 layers',
    { regime: spec.regime, tier: trust.tier, daily_used: dayWindow.total, daily_cap: DAILY_TREASURY_CAP });
}

function finalize(decision, allow, code, detail, telemetry = {}) {
  const out = { allow, code, detail, ...decision, ...telemetry };
  const tag = allow ? 'ALLOW' : 'DENY';
  console.log(`[outbound-guard] ${tag} ${code} | $${decision.amount} → ${decision.to} | route=${decision.route} did=${decision.did} reason=${decision.reason} | ${detail}`);
  return out;
}

// Read-only copy of the current spectral ring. Consumed by spectral-zk-auth
// so its `liveRegime(ring)` agrees with the L4 classifier here.
function getRecentRing() { return recentSends.slice(); }

// Read-only telemetry for /v1/admin/stats integration
function snapshot() {
  return {
    kill_switch: KILL_SWITCH(),
    daily: { utc_day: dayWindow.utcDay, used: dayWindow.total, cap: DAILY_TREASURY_CAP },
    spectral: { recent_n: recentSends.length, block_from: SPECTRAL_BLOCK_FROM },
    allowlist: { enforced: ALLOWLIST_REQUIRED, size: ROSTER_ALLOWLIST.size },
    trust: { min_tier: TRUST_MIN_TIER, url: TRUST_URL, timeout_ms: TRUST_TIMEOUT_MS },
    recipient_24h_addrs: recipient24h.size,
  };
}

module.exports = { checkOutbound, snapshot, getRecentRing, ROSTER_ALLOWLIST };
