// Hivebank /v1/admin/stats — read-only telemetry for the Leak Sentinel cron.
// 2026-04-25 H3 fix: fail-CLOSED on missing ADMIN_STATS_SECRET. Previously
// the route was open when the env var was unset, leaking current_epoch,
// nonce-cache size, daily-cap usage, and kill-switch state to anonymous
// callers — free targeting telemetry. Production MUST set the secret;
// dev/local must opt in via SPECTRAL_ZK_BYPASS or set ALLOW_OPEN_STATS=true.
//
// Auth: requires header `x-hive-internal: <ADMIN_STATS_SECRET>` (env-gated).
// If ADMIN_STATS_SECRET is unset the endpoint returns 503 unless
// ALLOW_OPEN_STATS=true is explicitly set (dev/local opt-in only).
//
// Exposes: throttle map state, DB circuit breaker state, capture-rate counters.
// NEVER exposes private keys, nonce values, signatures, or wallet contents.

const express = require('express');
const router  = express.Router();

// Lazy-load to avoid circular import: sentinel hooks attach as side properties
// on the router exports of usdc routes / usdc-transfer service.
let _usdcRouterMod, _usdcTransferMod, _outboundGuardMod, _spectralZkMod;
function getUsdcRouterMod() {
  if (!_usdcRouterMod) _usdcRouterMod = require('./usdc');
  return _usdcRouterMod;
}
function getUsdcTransferMod() {
  if (!_usdcTransferMod) _usdcTransferMod = require('../services/usdc-transfer');
  return _usdcTransferMod;
}
function getOutboundGuardMod() {
  if (!_outboundGuardMod) _outboundGuardMod = require('../services/outbound-guard');
  return _outboundGuardMod;
}
function getSpectralZkMod() {
  if (!_spectralZkMod) _spectralZkMod = require('../services/spectral-zk-auth');
  return _spectralZkMod;
}

// ─── Capture rate counter ────────────────────────────────────────────────────
// Sliding 60-min window of (request, capture) events. Bounded.
const captureWindow = { events: [] };
const CAP_WINDOW_MS = 60 * 60 * 1000;
const CAP_MAX_EVENTS = 4096;

function _bumpCapture(kind) {
  // kind:
  //   'request_real'    = inbound paying call that reached settlement path
  //   'request_replay'  = inbound that hit nonce-replay short-circuit (no leak)
  //   'request_expired' = inbound rejected by time-window pre-check (no leak)
  //   'capture'         = settled successfully on chain
  // Legacy 'request' is treated as request_real for back-compat.
  const k = (kind === 'request') ? 'request_real' : kind;
  const now = Date.now();
  captureWindow.events.push({ kind: k, t: now });
  const cutoff = now - CAP_WINDOW_MS;
  while (captureWindow.events.length && captureWindow.events[0].t < cutoff) {
    captureWindow.events.shift();
  }
  if (captureWindow.events.length > CAP_MAX_EVENTS) {
    captureWindow.events.splice(0, captureWindow.events.length - CAP_MAX_EVENTS);
  }
}

function _captureStats() {
  const now = Date.now();
  const cutoff = now - CAP_WINDOW_MS;
  let real = 0, replay = 0, expired = 0, cap = 0;
  for (const e of captureWindow.events) {
    if (e.t < cutoff) continue;
    if (e.kind === 'request_real')         real    += 1;
    else if (e.kind === 'request_replay')  replay  += 1;
    else if (e.kind === 'request_expired') expired += 1;
    else if (e.kind === 'capture')         cap     += 1;
  }
  // Leak = real, viable paying traffic but zero captures sustained over the window.
  // Replays + expired/not-yet-valid auths are by-design non-captures and must NOT
  // trigger the leak alarm — those are client-side mistakes, not service leaks.
  const total = real + replay + expired;
  return {
    requests_real_60min:    real,
    requests_replay_60min:  replay,
    requests_expired_60min: expired,
    captures_60min:         cap,
    capture_rate:           real === 0 ? 1 : cap / real,
    replay_share:           total === 0 ? 0 : replay  / total,
    expired_share:          total === 0 ? 0 : expired / total,
    leak_suspected:         real >= 5 && cap === 0,
  };
}

router.get('/stats', (req, res) => {
  const secret = process.env.ADMIN_STATS_SECRET;
  const allowOpen = process.env.ALLOW_OPEN_STATS === 'true';
  if (!secret && !allowOpen) {
    return res.status(503).json({ ok: false, error: 'stats endpoint not configured' });
  }
  if (secret) {
    const got = req.get('x-hive-internal');
    if (got !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  let throttle = null, breaker = null, outboundGuard = null, spectralZk = null;
  try { throttle = getUsdcRouterMod()._throttleStats?.() || null; } catch (e) {}
  try { breaker  = getUsdcTransferMod()._dbBreakerStats?.() || null; } catch (e) {}
  try { outboundGuard = getOutboundGuardMod().snapshot?.() || null; } catch (e) { outboundGuard = { error: e.message }; }
  try { spectralZk    = getSpectralZkMod().snapshot?.()   || null; } catch (e) { spectralZk    = { error: e.message }; }
  const capture = _captureStats();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime_s:  Math.round(process.uptime()),
    rss_mb:    Math.round(process.memoryUsage().rss / 1024 / 1024),
    throttle,
    db_breaker: breaker,
    capture,
    outbound_guard: outboundGuard,
    spectral_zk:    spectralZk,
  });
});

module.exports = router;
module.exports._bumpCapture = _bumpCapture;
