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
  assert.equal(r.code, 'BAD_SIGNATURE');
});

test('snapshot exposes config', () => {
  const zk = require('../src/services/spectral-zk-auth');
  const s = zk.snapshot();
  assert.equal(s.enforced, true);
  assert.ok(typeof s.epoch_sec === 'number');
  assert.ok(Array.isArray(s.valid_regimes));
});
