'use strict';

/**
 * Treasury-address resolver — fail closed.
 *
 * No hardcoded fallbacks. If HOUSE_WALLET (or TREASURY_WALLET) is missing
 * or malformed, callers MUST receive a thrown error; this prevents the
 * old-treasury fallback antipattern (`process.env.HOUSE_WALLET || '0xE5588...'`)
 * from ever recurring after a key/wallet rotation.
 *
 * Rotated 2026-04-25: old drained treasury 0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe
 *                     replaced via ceremony (PR #6 treasury-fallback-purge).
 *
 * Invariant: every reference to the treasury address in source code MUST go
 * through getTreasuryAddress(). The CI guard scripts/check-no-leaked-treasury.sh
 * blocks both literal embedding and the `||` fallback antipattern.
 *
 * HiveFilter: 22/22
 */

let cachedAddress = null;

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

function readEnvAddress() {
  // HOUSE_WALLET is the canonical env name. TREASURY_WALLET is a synonym
  // some services historically used; honor it for backward compat ONLY
  // when HOUSE_WALLET is absent. Both are read from process.env at call time.
  const v = process.env.HOUSE_WALLET || process.env.TREASURY_WALLET;
  if (!v || typeof v !== 'string') return null;
  if (!ADDR_RE.test(v)) return null;
  return v;
}

/**
 * Returns the current treasury address (EVM 0x... checksum-or-lower).
 * Throws if env not set or malformed — fail closed, no silent fallbacks.
 */
function getTreasuryAddress() {
  if (cachedAddress !== null) return cachedAddress;
  const a = readEnvAddress();
  if (!a) {
    throw new Error(
      'HOUSE_WALLET (or TREASURY_WALLET) not set or invalid — refusing to operate without treasury address. Configure env var on the service before deploying.'
    );
  }
  cachedAddress = a;
  return cachedAddress;
}

/**
 * Test-only: clear the in-process cache so tests can swap the env var.
 */
function _resetCacheForTests() {
  cachedAddress = null;
}

module.exports = {
  getTreasuryAddress,
  _resetCacheForTests,
};
