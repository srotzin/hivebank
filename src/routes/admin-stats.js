// Hivebank /v1/admin/stats — read-only telemetry for the Leak Sentinel cron.
//
// Auth: requires header `x-hive-internal: <ADMIN_STATS_SECRET>` (env-gated).
// Falls back to allowing the call when ADMIN_STATS_SECRET is unset, so dev/local
// works without ceremony — but in production set the env to lock it down.
//
// Exposes: throttle map state, DB circuit breaker state, capture-rate counters.
// NEVER exposes private keys, nonce values, signatures, or wallet contents.

const express = require('express');
const router  = express.Router();

// Lazy-load to avoid circular import: sentinel hooks attach as side properties
// on the router exports of usdc routes / usdc-transfer service.
let _usdcRouterMod, _usdcTransferMod;
function getUsdcRouterMod() {
  if (!_usdcRouterMod) _usdcRouterMod = require('./usdc');
  return _usdcRouterMod;
}
function getUsdcTransferMod() {
  if (!_usdcTransferMod) _usdcTransferMod = require('../services/usdc-transfer');
  return _usdcTransferMod;
}

// ─── Capture rate counter ────────────────────────────────────────────────────
// Sliding 60-min window of (request, capture) events. Bounded.
const captureWindow = { events: [] };
const CAP_WINDOW_MS = 60 * 60 * 1000;
const CAP_MAX_EVENTS = 4096;

function _bumpCapture(kind) {
  // kind: 'request' (any inbound paying call) | 'capture' (settled successfully)
  const now = Date.now();
  captureWindow.events.push({ kind, t: now });
  // bound + age out
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
  let req = 0, cap = 0;
  for (const e of captureWindow.events) {
    if (e.t < cutoff) continue;
    if (e.kind === 'request') req += 1;
    else if (e.kind === 'capture') cap += 1;
  }
  return {
    requests_60min: req,
    captures_60min: cap,
    capture_rate:   req === 0 ? 1 : cap / req,
    leak_suspected: req > 0 && cap === 0,
  };
}

router.get('/stats', (req, res) => {
  const secret = process.env.ADMIN_STATS_SECRET;
  if (secret) {
    const got = req.get('x-hive-internal');
    if (got !== secret) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  let throttle = null, breaker = null;
  try { throttle = getUsdcRouterMod()._throttleStats?.() || null; } catch (e) {}
  try { breaker  = getUsdcTransferMod()._dbBreakerStats?.() || null; } catch (e) {}
  const capture = _captureStats();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    uptime_s:  Math.round(process.uptime()),
    rss_mb:    Math.round(process.memoryUsage().rss / 1024 / 1024),
    throttle,
    db_breaker: breaker,
    capture,
  });
});

module.exports = router;
module.exports._bumpCapture = _bumpCapture;
