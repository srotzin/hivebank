// Unit tests for spectral-zk-auth (Spectral Zero-Knowledge Outbound Auth).
//
// Run: node --test test/spectral-zk-auth.test.js

'use strict';

const test     = require('node:test');
const assert   = require('node:assert');
const ed       = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha2');

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// Generate a test keypair and inject the public key BEFORE require.
const sk = ed.utils.randomPrivateKey();
async function setup() {
  const pk = await ed.getPublicKeyAsync(sk);
  process.env.SPECTRAL_VERIFIER_PK_B64U = Buffer.from(pk).toString('base64url');
  process.env.SPECTRAL_ZK_ENFORCE       = 'true';
  process.env.SPECTRAL_ZK_BYPASS        = 'false';
  process.env.SPECTRAL_EPOCH_SEC        = '300';
}

test('round-trip — issue + verify a valid ticket', async () => {
  await setup();
  const zk = require('../src/services/spectral-zk-auth');

  const intent_hex = zk.intentHash({
    toAddress: '0x53213cfebbef44fae36282a1096da3d2282de54a',
    amountUsdc: 1.5,
    reason: 'unit_test',
    hiveDid: 'did:hive:test',
  });
  const ring = [];   // empty → both sides classify WARMUP

  const ticket = await zk.issueTicket({
    issuerSk32:   sk,
    issuerDid:    'did:hive:test-issuer',
    regime:       zk.liveRegime(ring),  // WARMUP
    intent_hex,
    expSec:       60,
  });

  const r = await zk.verifyTicket(ticket, intent_hex, ring);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.code, 'OK');
});

test('rejects missing ticket', async () => {
  await setup();
  const zk = require('../src/services/spectral-zk-auth');
  const r  = await zk.verifyTicket(null, 'deadbeef', []);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_TICKET');
});

test('rejects ticket with wrong intent hash', async () => {
  await setup();
  const zk = require('../src/services/spectral-zk-auth');
  const ring = [];
  const ticket = await zk.issueTicket({
    issuerSk32: sk, issuerDid: 'did:hive:test-issuer',
    regime: zk.liveRegime(ring),
    intent_hex: zk.intentHash({ toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '' }),
    expSec: 60,
  });
  // Verify with a DIFFERENT intent hash
  const r = await zk.verifyTicket(ticket, 'cafef00d', ring);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INTENT_MISMATCH');
});

test('rejects ticket with wrong regime', async () => {
  await setup();
  const zk = require('../src/services/spectral-zk-auth');
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  // Issue with regime LOW_RED — but live ring is empty so live=WARMUP
  const ticket = await zk.issueTicket({
    issuerSk32: sk, issuerDid: 'did:hive:test-issuer',
    regime: 'NORMAL_CYAN', intent_hex, expSec: 60,
  });
  const r = await zk.verifyTicket(ticket, intent_hex, []);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGIME_MISMATCH');
});

test('rejects nonce replay', async () => {
  await setup();
  // Force a fresh module instance so its nonceSeen cache is empty.
  delete require.cache[require.resolve('../src/services/spectral-zk-auth')];
  const zk = require('../src/services/spectral-zk-auth');
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  const ring = [];
  const ticket = await zk.issueTicket({
    issuerSk32: sk, issuerDid: 'did:hive:test-issuer',
    regime: zk.liveRegime(ring), intent_hex, expSec: 60,
  });
  const r1 = await zk.verifyTicket(ticket, intent_hex, ring);
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const r2 = await zk.verifyTicket(ticket, intent_hex, ring);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'NONCE_REPLAY');
});

test('rejects bad signature (key mismatch)', async () => {
  await setup();
  const zk = require('../src/services/spectral-zk-auth');
  // Issue with a DIFFERENT random key than the verifier expects
  const wrongSk = ed.utils.randomPrivateKey();
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  const ring = [];
  const ticket = await zk.issueTicket({
    issuerSk32: wrongSk, issuerDid: 'did:hive:test-issuer',
    regime: zk.liveRegime(ring), intent_hex, expSec: 60,
  });
  const r = await zk.verifyTicket(ticket, intent_hex, ring);
  assert.equal(r.ok, false);
  // 2026-04-25 H2 fix: pre-sig and bad-sig failures all collapse to opaque
  // INVALID so the verifier doesn't act as a regime/epoch oracle.
  assert.equal(r.code, 'INVALID');
});

test('H1 regression — concurrent verifies of same valid ticket: exactly one wins', async () => {
  await setup();
  delete require.cache[require.resolve('../src/services/spectral-zk-auth')];
  const zk = require('../src/services/spectral-zk-auth');
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  const ring = [];
  const ticket = await zk.issueTicket({
    issuerSk32: sk, issuerDid: 'did:hive:test-issuer',
    regime: zk.liveRegime(ring), intent_hex, expSec: 60,
  });
  // Fire 10 verifies in parallel — they all clear sig in parallel, but only
  // ONE may claim the nonce. This protects against the in-flight replay
  // attack identified in the 2026-04-25 red-team review.
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    zk.verifyTicket(ticket, intent_hex, ring)));
  const oks = results.filter(r => r.ok).length;
  assert.equal(oks, 1, `expected exactly one parallel verify to succeed, got ${oks}`);
});

test('H2 regression — pre-sig and bad-sig errors are indistinguishable', async () => {
  await setup();
  delete require.cache[require.resolve('../src/services/spectral-zk-auth')];
  const zk = require('../src/services/spectral-zk-auth');
  // Construct THREE tampered tickets that hit different pre-sig branches.
  // All MUST return code: INVALID — not REGIME_MISMATCH, EPOCH_DRIFT, etc.
  const wrongSk = ed.utils.randomPrivateKey();
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  // Bad signature
  const t1 = await zk.issueTicket({
    issuerSk32: wrongSk, issuerDid: 'did:hive:test-issuer',
    regime: 'WARMUP', intent_hex, expSec: 60,
  });
  // Bad version (manipulate the JSON)
  const t2 = Buffer.from(JSON.stringify({
    v: 99, iss: 'did:hive:test-issuer', epoch: '2026-04-25T12:00:00Z',
    regime: 'WARMUP', intent: intent_hex,
    nonce: 'AAAA', exp: '2030-01-01T00:00:00Z', sig: 'AAAA',
  })).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  // Missing field
  const t3 = Buffer.from(JSON.stringify({
    v: 1, iss: 'x', epoch: 'x', regime: 'x', intent: 'x', nonce: 'x', /* exp missing */ sig: 'x',
  })).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const r1 = await zk.verifyTicket(t1, intent_hex, []);
  const r2 = await zk.verifyTicket(t2, intent_hex, []);
  const r3 = await zk.verifyTicket(t3, intent_hex, []);
  assert.equal(r1.code, 'INVALID', 'bad sig should be INVALID');
  assert.equal(r2.code, 'INVALID', 'bad version should be INVALID');
  assert.equal(r3.code, 'INVALID', 'missing field should be INVALID');
});

test('H2 regression — issuer-signed but stale tickets DO get specific codes', async () => {
  await setup();
  delete require.cache[require.resolve('../src/services/spectral-zk-auth')];
  const zk = require('../src/services/spectral-zk-auth');
  const intent_hex = zk.intentHash({
    toAddress: 'a', amountUsdc: 1, reason: 'x', hiveDid: '',
  });
  // Properly signed ticket with WRONG regime relative to live (live=WARMUP)
  const ticket = await zk.issueTicket({
    issuerSk32: sk, issuerDid: 'did:hive:test-issuer',
    regime: 'NORMAL_CYAN', intent_hex, expSec: 60,
  });
  const r = await zk.verifyTicket(ticket, intent_hex, []);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'REGIME_MISMATCH', 'post-sig branches keep their specific codes');
});

test('snapshot exposes config', () => {
  const zk = require('../src/services/spectral-zk-auth');
  const s = zk.snapshot();
  assert.equal(s.enforced, true);
  assert.ok(typeof s.epoch_sec === 'number');
  assert.ok(Array.isArray(s.valid_regimes));
});
