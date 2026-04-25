// Tests for lib/internal-key — fail-closed reader for HIVE_INTERNAL_KEY.
// Run: node --test test/internal-key.test.js
//
// HiveFilter: 22/22

'use strict';

const test   = require('node:test');
const assert = require('node:assert');

// Fresh require per test (cache reset)
function freshKeyLib() {
  const path = require.resolve('../src/lib/internal-key');
  delete require.cache[path];
  return require('../src/lib/internal-key');
}

test('throws when HIVE_INTERNAL_KEY is unset', () => {
  delete process.env.HIVE_INTERNAL_KEY;
  const lib = freshKeyLib();
  assert.throws(() => lib.getInternalKey(), /HIVE_INTERNAL_KEY not set/);
});

test('throws when HIVE_INTERNAL_KEY is empty string', () => {
  process.env.HIVE_INTERNAL_KEY = '';
  const lib = freshKeyLib();
  assert.throws(() => lib.getInternalKey(), /HIVE_INTERNAL_KEY not set/);
});

test('throws when HIVE_INTERNAL_KEY is too short', () => {
  process.env.HIVE_INTERNAL_KEY = 'short';
  const lib = freshKeyLib();
  assert.throws(() => lib.getInternalKey(), /HIVE_INTERNAL_KEY not set/);
});

test('returns env value when set and valid', () => {
  const valid = 'hive_internal_test_' + 'a'.repeat(60);
  process.env.HIVE_INTERNAL_KEY = valid;
  const lib = freshKeyLib();
  assert.strictEqual(lib.getInternalKey(), valid);
});

test('caches first read; subsequent reads do not re-check env', () => {
  const valid = 'hive_internal_test_' + 'b'.repeat(60);
  process.env.HIVE_INTERNAL_KEY = valid;
  const lib = freshKeyLib();
  assert.strictEqual(lib.getInternalKey(), valid);

  // mutate env, but cached value should persist
  process.env.HIVE_INTERNAL_KEY = 'hive_internal_test_' + 'c'.repeat(60);
  assert.strictEqual(lib.getInternalKey(), valid);

  // reset for tests
  lib._resetCacheForTests();
  assert.strictEqual(lib.getInternalKey(), 'hive_internal_test_' + 'c'.repeat(60));
});

test('requireInternalKey middleware: 503 when env unset', () => {
  delete process.env.HIVE_INTERNAL_KEY;
  const lib = freshKeyLib();
  let status, body;
  const res = {
    status(s) { status = s; return this; },
    json(b)   { body = b; return this; },
  };
  let called = false;
  lib.requireInternalKey({ headers: { 'x-hive-internal': 'whatever' } }, res, () => { called = true; });
  assert.strictEqual(status, 503);
  assert.strictEqual(body.error, 'INTERNAL_KEY_NOT_CONFIGURED');
  assert.strictEqual(called, false);
});

test('requireInternalKey middleware: 401 when key wrong', () => {
  process.env.HIVE_INTERNAL_KEY = 'hive_internal_test_' + 'd'.repeat(60);
  const lib = freshKeyLib();
  let status, body;
  const res = {
    status(s) { status = s; return this; },
    json(b)   { body = b; return this; },
  };
  let called = false;
  lib.requireInternalKey({ headers: { 'x-hive-internal': 'wrong-key' } }, res, () => { called = true; });
  assert.strictEqual(status, 401);
  assert.strictEqual(body.error, 'INTERNAL_KEY_REQUIRED');
  assert.strictEqual(called, false);
});

test('requireInternalKey middleware: 401 when no header', () => {
  process.env.HIVE_INTERNAL_KEY = 'hive_internal_test_' + 'e'.repeat(60);
  const lib = freshKeyLib();
  let status, body;
  const res = {
    status(s) { status = s; return this; },
    json(b)   { body = b; return this; },
  };
  let called = false;
  lib.requireInternalKey({ headers: {} }, res, () => { called = true; });
  assert.strictEqual(status, 401);
  assert.strictEqual(called, false);
});

test('requireInternalKey middleware: passes when header matches', () => {
  const valid = 'hive_internal_test_' + 'f'.repeat(60);
  process.env.HIVE_INTERNAL_KEY = valid;
  const lib = freshKeyLib();
  let called = false;
  lib.requireInternalKey({ headers: { 'x-hive-internal': valid } }, { status() {} }, () => { called = true; });
  assert.strictEqual(called, true);
});

test('requireInternalKey middleware: accepts x-hive-internal-key alt header', () => {
  const valid = 'hive_internal_test_' + 'g'.repeat(60);
  process.env.HIVE_INTERNAL_KEY = valid;
  const lib = freshKeyLib();
  let called = false;
  lib.requireInternalKey({ headers: { 'x-hive-internal-key': valid } }, { status() {} }, () => { called = true; });
  assert.strictEqual(called, true);
});
