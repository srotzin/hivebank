// Unit tests for outbound-guard (Spectral Hardened Outbound Defense).
//
// Run: node --test test/outbound-guard.test.js
//
// We exercise the 6 layers in isolation by configuring env BEFORE require.

'use strict';

const test    = require('node:test');
const assert  = require('node:assert');

// Configure for tests — disable trust HTTP, allowlist-required, small caps.
process.env.OUTBOUND_ALLOWLIST_REQUIRED = 'true';
process.env.OUTBOUND_DAILY_CAP_USD      = '10';
process.env.OUTBOUND_PER_RECIPIENT_CAP  = '5';
process.env.OUTBOUND_TRUST_MIN_TIER     = 'VOID';   // accept any (we test L5 separately)
process.env.USDC_SENDS_PAUSED           = 'false';
process.env.OUTBOUND_SPECTRAL_BLOCK_FROM = 'HIGH_VIOLET';

// Mock fetch so trustCheck doesn't go to network — return MOZ-tier OK.
global.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ data: { tier: 'MOZ' } }),
});

const guard = require('../src/services/outbound-guard');

// Hive3, Hive4, Hive5 — all known to be in the hardcoded ROSTER_ALLOWLIST.
const HIVE3  = '0x53213cfebbef44fae36282a1096da3d2282de54a';
const HIVE4  = '0x20626c42dfa13a34708f5260a78e0c7b318ece51';
const HIVE5  = '0xd945841ac3481c478b9464773e4f9b15a2ae1a74';
const FORBID = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

test('L0 — kill switch denies', async () => {
  process.env.USDC_SENDS_PAUSED = 'true';
  const r = await guard.checkOutbound({ toAddress: HIVE3, amountUsdc: 1, route: 'test' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'L0_KILL_SWITCH');
  process.env.USDC_SENDS_PAUSED = 'false';
});

test('L1 — non-allowlisted address denies', async () => {
  const r = await guard.checkOutbound({ toAddress: FORBID, amountUsdc: 1, route: 'test' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'L1_ALLOWLIST');
});

test('L3 — per-recipient cap denies repeated same-address sends', async () => {
  // Per-recipient cap is $5 — $4 clears, then $4 should deny.
  let r = await guard.checkOutbound({ toAddress: HIVE3, amountUsdc: 4, route: 'test' });
  assert.equal(r.allow, true, JSON.stringify(r));
  r = await guard.checkOutbound({ toAddress: HIVE3, amountUsdc: 4, route: 'test' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'L3_RECIPIENT_CAP');
});

test('L2 — daily cap denies above limit (different recipients)', async () => {
  // Daily cap is $10. Already spent $4 on HIVE3 above.
  // $4 to HIVE4 should clear (total $8). $4 to HIVE5 should deny via L2.
  let r = await guard.checkOutbound({ toAddress: HIVE4, amountUsdc: 4, route: 'test' });
  assert.equal(r.allow, true, JSON.stringify(r));
  r = await guard.checkOutbound({ toAddress: HIVE5, amountUsdc: 4, route: 'test' });
  assert.equal(r.allow, false);
  assert.equal(r.code, 'L2_DAILY_CAP');
});

test('snapshot exposes daily + spectral counters', () => {
  const s = guard.snapshot();
  assert.ok(typeof s.daily.used === 'number');
  assert.ok(typeof s.spectral.recent_n === 'number');
  assert.ok(typeof s.allowlist.size === 'number');
});

test('getRecentRing returns array', () => {
  const r = guard.getRecentRing();
  assert.ok(Array.isArray(r));
});
