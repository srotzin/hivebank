// outbound-guard.js — Spectral Hardened Outbound Defense (SHOD).
//
// Six-layer defense that every USDC send must pass before sendUSDCOnChain
// will broadcast a transaction. Designed in response to the 2026-04-25
// $99.99 incident, where 10 sequential $10 sends to fresh EOAs drained
// $99.99 in 30 minutes through /v1/bank/usdc/send.
//
// LAYERS (each fail returns ok:false with a specific code):
//   L0  KILL_SWITCH        — USDC_SENDS_PAUSED env flag (already exists)
//   L1  ALLOWLIST_HARD     — destination must be in the route's effective
//                            allowlist. Default route uses the 35-wallet
//                            roster (Hive3-Hive37). Other routes plug in
//                            their own allowlists via registerRoute().
//   L2  DAILY_TREASURY_CAP — total outbound USD per route, capped per UTC
//                            day. Each route gets its OWN bucket, so
//                            prospector cannot eat the dispatcher budget
//                            and vice versa. Reset at 00:00 UTC.
//   L3  PER_RECIPIENT_CAP  — sliding 24h cap per address, ALSO per route.
//                            A prospector winner getting $5 does not
//                            consume their 'default' refill cap.
//   L4  SPECTRAL_ANOMALY   — feeds the rolling 60-window of per-tx
//                            amounts (PER ROUTE) into the HiveChroma
//                            spectral classifier. Prospector rebates
//                            ($1/$3/$5) cannot poison the dispatcher
//                            classifier and vice versa. If a route's
//                            regime crosses into Hδ (HIGH_VIOLET) or
//                            worse, that route is blocked; others
//                            unaffected.
//   L5  TRUST_GATE         — if the request carries a hive_did, looks up
//                            its trust tier on hivetrust.onrender.com.
//                            Min tier is per-route (default MOZ; the
//                            'prospector' route uses VOID because the
//                            qualifier already proved 3 paid calls).
//   L6  AUDIT_TRAIL        — every decision (allow/deny/anomaly) is
//                            written to outbound_audit table AND a
//                            short-lived in-memory ring used by L4.
//
// All layers are safe-by-default: any unhandled error → block.
// All decisions log a structured `[outbound-guard]` line so Render Logs
// + Leak Sentinel can attribute the cause without DB access.
//
// 2026-04-29 refactor: per-route state buckets so adding a new outbound
// route (prospector, future bounty escrow, future referral programs) does
// not require disabling any layer for "the new traffic shape." Each route
// gets its own L1/L2/L3/L4/L5 parameters but every send still runs every
// layer. No regression on the post-incident hardening.

'use strict';

const { classifyPriceWindow, REGIMES } = require('../lib/spectral');

// ─── Default config (overridable per-route via registerRoute) ────────────────
const KILL_SWITCH         = () => process.env.USDC_SENDS_PAUSED === 'true';
const DEFAULT_DAILY_CAP   = parseFloat(process.env.OUTBOUND_DAILY_CAP_USD     || '50');
const DEFAULT_RECIP_CAP   = parseFloat(process.env.OUTBOUND_PER_RECIPIENT_CAP || '20');
const DEFAULT_SPECTRAL_BLOCK_FROM = (process.env.OUTBOUND_SPECTRAL_BLOCK_FROM || 'HIGH_VIOLET').toUpperCase();
const DEFAULT_ALLOWLIST_REQUIRED  = process.env.OUTBOUND_ALLOWLIST_REQUIRED !== 'false';   // default ON
const DEFAULT_TRUST_MIN_TIER      = (process.env.OUTBOUND_TRUST_MIN_TIER  || 'MOZ').toUpperCase();
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

const RECENT_MAX = 60;

// ─── Per-route state registry ───────────────────────────────────────────────
// Each route gets its own L2 daily window, L3 recipient map, L4 spectral ring.
// Routes are registered at module-load time. A request with an unregistered
// route name falls through to the 'default' route's state and parameters.

function makeRouteState(params) {
  return {
    name: params.name,
    // L1 — allowlist (Set<lowercase address>) or null to use roster + dynamic
    allowlist: params.allowlist || null,
    allowlistRequired: typeof params.allowlistRequired === 'boolean'
      ? params.allowlistRequired : DEFAULT_ALLOWLIST_REQUIRED,
    // L2 — daily cap state
    dailyCap: typeof params.dailyCap === 'number' ? params.dailyCap : DEFAULT_DAILY_CAP,
    dayWindow: { utcDay: '', total: 0 },
    // L3 — per-recipient state
    perRecipientCap: typeof params.perRecipientCap === 'number'
      ? params.perRecipientCap : DEFAULT_RECIP_CAP,
    recipient24h: new Map(),  // addrLc → [{ts, amt}]
    // L4 — spectral ring
    recentSends: [],
    spectralBlockFrom: (params.spectralBlockFrom || DEFAULT_SPECTRAL_BLOCK_FROM).toUpperCase(),
    // L5 — trust gate
    trustMinTier: (params.trustMinTier || DEFAULT_TRUST_MIN_TIER).toUpperCase(),
    // Optional per-route extras for future use
    extras: params.extras || {},
  };
}

const ROUTES = new Map();

// Register the default route first — preserves the original behavior so any
// code path that doesn't pass route='X' continues to behave exactly as before
// the refactor.
ROUTES.set('default', makeRouteState({
  name: 'default',
  allowlist: ROSTER_ALLOWLIST,
  allowlistRequired: DEFAULT_ALLOWLIST_REQUIRED,
  dailyCap: DEFAULT_DAILY_CAP,
  perRecipientCap: DEFAULT_RECIP_CAP,
  spectralBlockFrom: DEFAULT_SPECTRAL_BLOCK_FROM,
  trustMinTier: DEFAULT_TRUST_MIN_TIER,
}));

// Registers (or replaces) a named route's params. Idempotent. Routes whose
// allowlist is dynamic (e.g. prospector winners) should pass `allowlist` as
// a Set and mutate it via addToAllowlist/removeFromAllowlist.
function registerRoute(params) {
  if (!params || !params.name) throw new Error('registerRoute requires params.name');
  ROUTES.set(params.name, makeRouteState(params));
  console.log(`[outbound-guard] route registered: ${params.name} ` +
    `(daily=$${ROUTES.get(params.name).dailyCap}, recip=$${ROUTES.get(params.name).perRecipientCap}, ` +
    `min_tier=${ROUTES.get(params.name).trustMinTier}, ` +
    `allowlist_size=${ROUTES.get(params.name).allowlist ? ROUTES.get(params.name).allowlist.size : 0})`);
  return ROUTES.get(params.name);
}

function getRoute(name) {
  return ROUTES.get(name) || ROUTES.get('default');
}

function addToAllowlist(routeName, address) {
  const r = ROUTES.get(routeName);
  if (!r || !r.allowlist) return false;
  r.allowlist.add(String(address).toLowerCase());
  return true;
}

function removeFromAllowlist(routeName, address) {
  const r = ROUTES.get(routeName);
  if (!r || !r.allowlist) return false;
  return r.allowlist.delete(String(address).toLowerCase());
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function utcDayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

function pruneOlderThan(arr, cutoffMs) {
  const now = Date.now();
  while (arr.length && (now - arr[0].ts) > cutoffMs) arr.shift();
}

function tierIndex(tier) { return TIER_ORDER.indexOf(String(tier || '').toUpperCase()); }

// ─── L4 — spectral anomaly classifier (per-route ring) ──────────────────────
function spectralCheck(route, amount) {
  route.recentSends.push(amount);
  if (route.recentSends.length > RECENT_MAX) route.recentSends.shift();
  if (route.recentSends.length < 10) {
    return { allow: true, regime: 'WARMUP', n: route.recentSends.length };
  }
  const cls = classifyPriceWindow(route.recentSends);
  const order = REGIMES.map(r => r.name);
  const blockIdx = order.indexOf(route.spectralBlockFrom);
  const curIdx   = order.indexOf(cls.regime);
  if (blockIdx >= 0 && curIdx >= 0 && curIdx >= blockIdx) {
    return { allow: false, regime: cls.regime, vol_ratio: cls.stats.vol_ratio, n: route.recentSends.length };
  }
  return { allow: true, regime: cls.regime, vol_ratio: cls.stats.vol_ratio, n: route.recentSends.length };
}

// ─── L5 — HiveTrust DID gate ────────────────────────────────────────────────
async function trustCheck(hiveDid, minTier) {
  if (!hiveDid) {
    return { allow: true, tier: 'unknown', reason: 'no_did' };
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TRUST_TIMEOUT_MS);
    const r = await fetch(`${TRUST_URL}/v1/trust/tier?did=${encodeURIComponent(hiveDid)}`, {
      signal: ctrl.signal,
      headers: { 'x-hive-tier': 'enterprise' },
    });
    clearTimeout(t);
    if (!r.ok) return { allow: false, tier: 'unreachable', reason: `trust_http_${r.status}` };
    const j = await r.json();
    const tier = (j.tier || 'VOID').toUpperCase();
    if (tierIndex(tier) < tierIndex(minTier)) {
      return { allow: false, tier, reason: `tier_below_min_${minTier}` };
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
  const routeName = route || 'default';
  const r = getRoute(routeName);

  const decision = {
    ts: new Date().toISOString(),
    to: toAddress,
    amount: amountUsdc,
    did: hiveDid || null,
    reason: reason || null,
    route: routeName,
  };

  // L0 kill switch (defence in depth — usdc-transfer.js has its own)
  if (KILL_SWITCH()) {
    return finalize(decision, false, 'L0_KILL_SWITCH', 'USDC_SENDS_PAUSED=true');
  }

  // L1 hard allowlist (per-route)
  if (r.allowlistRequired) {
    const lc = String(toAddress || '').toLowerCase();
    if (!r.allowlist || !r.allowlist.has(lc)) {
      return finalize(decision, false, 'L1_ALLOWLIST',
        `Recipient ${toAddress} is not in the '${routeName}' route allowlist (size=${r.allowlist ? r.allowlist.size : 0}). Add via the route's qualifier or use OUTBOUND_ALLOWLIST_REQUIRED=false.`);
    }
  }

  // L2 daily treasury cap (per-route)
  const today = utcDayKey();
  if (r.dayWindow.utcDay !== today) { r.dayWindow.utcDay = today; r.dayWindow.total = 0; }
  if (r.dayWindow.total + amountUsdc > r.dailyCap) {
    return finalize(decision, false, 'L2_DAILY_CAP',
      `Route '${routeName}' daily cap $${r.dailyCap} would be exceeded ($${r.dayWindow.total.toFixed(2)} already + $${amountUsdc.toFixed(2)} = $${(r.dayWindow.total+amountUsdc).toFixed(2)}).`);
  }

  // L3 per-recipient 24h cap (per-route)
  const lc = String(toAddress || '').toLowerCase();
  const arr = r.recipient24h.get(lc) || [];
  pruneOlderThan(arr, 24 * 60 * 60 * 1000);
  const recipTotal = arr.reduce((s, x) => s + x.amt, 0);
  if (recipTotal + amountUsdc > r.perRecipientCap) {
    return finalize(decision, false, 'L3_RECIPIENT_CAP',
      `Route '${routeName}' recipient cap $${r.perRecipientCap}/24h exceeded for ${lc} ($${recipTotal.toFixed(2)} + $${amountUsdc.toFixed(2)}).`);
  }

  // L4 spectral anomaly (per-route ring)
  const spec = spectralCheck(r, amountUsdc);
  if (!spec.allow) {
    r.recentSends.pop();   // don't poison ring with a blocked attempt
    return finalize(decision, false, 'L4_SPECTRAL',
      `Route '${routeName}' send pattern entered ${spec.regime} regime (vol_ratio=${(spec.vol_ratio || 0).toFixed(4)}, n=${spec.n}). Likely automated drain. Operator unlock required.`,
      { regime: spec.regime, vol_ratio: spec.vol_ratio });
  }

  // L5 trust gate (per-route min tier)
  const trust = await trustCheck(hiveDid, r.trustMinTier);
  if (!trust.allow) {
    r.recentSends.pop();
    return finalize(decision, false, 'L5_TRUST',
      `Route '${routeName}' DID ${hiveDid || '<missing>'} did not meet min tier ${r.trustMinTier} (got ${trust.tier}, ${trust.reason}).`,
      { tier: trust.tier });
  }

  // ALL CLEAR — commit state
  r.dayWindow.total += amountUsdc;
  arr.push({ ts: Date.now(), amt: amountUsdc });
  r.recipient24h.set(lc, arr);
  return finalize(decision, true, 'OK', `cleared all 6 layers on route '${routeName}'`,
    { regime: spec.regime, tier: trust.tier, daily_used: r.dayWindow.total, daily_cap: r.dailyCap });
}

function finalize(decision, allow, code, detail, telemetry = {}) {
  const out = { allow, code, detail, ...decision, ...telemetry };
  const tag = allow ? 'ALLOW' : 'DENY';
  console.log(`[outbound-guard] ${tag} ${code} | $${decision.amount} → ${decision.to} | route=${decision.route} did=${decision.did} reason=${decision.reason} | ${detail}`);
  return out;
}

// Read-only copy of the current spectral ring for a given route. Consumed by
// spectral-zk-auth so its `liveRegime(ring)` agrees with the L4 classifier here.
// Defaults to the 'default' route's ring for backward compat with existing
// callers that don't pass a route name.
function getRecentRing(routeName = 'default') {
  const r = getRoute(routeName);
  return r.recentSends.slice();
}

// Read-only telemetry for /v1/admin/stats integration
function snapshot() {
  const routes = {};
  for (const [name, r] of ROUTES.entries()) {
    routes[name] = {
      daily: { utc_day: r.dayWindow.utcDay, used: r.dayWindow.total, cap: r.dailyCap },
      spectral: { recent_n: r.recentSends.length, block_from: r.spectralBlockFrom },
      allowlist: { enforced: r.allowlistRequired, size: r.allowlist ? r.allowlist.size : 0 },
      trust: { min_tier: r.trustMinTier },
      recipient_24h_addrs: r.recipient24h.size,
    };
  }
  return {
    kill_switch: KILL_SWITCH(),
    trust: { url: TRUST_URL, timeout_ms: TRUST_TIMEOUT_MS },
    routes,
  };
}

module.exports = {
  checkOutbound,
  snapshot,
  getRecentRing,
  registerRoute,
  addToAllowlist,
  removeFromAllowlist,
  ROSTER_ALLOWLIST,
};
