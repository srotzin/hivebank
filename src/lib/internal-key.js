'use strict';

/**
 * Internal-key resolver — fail closed.
 *
 * No hardcoded fallbacks. If HIVE_INTERNAL_KEY is missing or empty,
 * callers MUST receive a thrown error; this prevents the leaked-key
 * fallback antipattern (key embedded in source as `||` default) from
 * ever recurring.
 *
 * Rotated 2026-04-25 after castle-seal Spectral key ceremony.
 * Prior leaked value (DEAD): hive_internal_125e04e0...327d46
 *
 * HiveFilter: 22/22
 */

let cachedKey = null;

function readEnvKey() {
  const v = process.env.HIVE_INTERNAL_KEY;
  if (!v || typeof v !== 'string' || v.length < 32) {
    return null;
  }
  return v;
}

/**
 * Returns the current process HIVE_INTERNAL_KEY.
 * Throws if env not set — fail closed, no silent fallbacks.
 */
function getInternalKey() {
  if (cachedKey !== null) return cachedKey;
  const k = readEnvKey();
  if (!k) {
    throw new Error(
      'HIVE_INTERNAL_KEY not set or invalid — refusing to operate without internal auth key. Configure env var on the service before deploying.'
    );
  }
  cachedKey = k;
  return cachedKey;
}

/**
 * Test-only: clear the in-process cache so tests can swap the env var.
 */
function _resetCacheForTests() {
  cachedKey = null;
}

/**
 * Express middleware for endpoints behind x-hive-internal:
 *   app.get('/x', requireInternalKey, handler)
 *
 * 401 if header missing/wrong, 503 if env not configured.
 */
function requireInternalKey(req, res, next) {
  let expected;
  try {
    expected = getInternalKey();
  } catch (e) {
    return res.status(503).json({
      status: 'error',
      error: 'INTERNAL_KEY_NOT_CONFIGURED',
      message: 'Service is missing HIVE_INTERNAL_KEY env. Refusing to operate.',
    });
  }
  const got = req.headers['x-hive-internal'] || req.headers['x-hive-internal-key'];
  if (!got || got !== expected) {
    return res.status(401).json({ status: 'error', error: 'INTERNAL_KEY_REQUIRED' });
  }
  return next();
}

module.exports = {
  getInternalKey,
  requireInternalKey,
  _resetCacheForTests,
};
