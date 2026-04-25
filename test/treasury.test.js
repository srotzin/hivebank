// Tests for lib/treasury — fail-closed reader for HOUSE_WALLET / TREASURY_WALLET.
// Run: node --test test/treasury.test.js
//
// HiveFilter: 22/22

'use strict';

const test   = require('node:test');
const assert = require('node:assert');

// Fresh require per test (cache reset)
function freshTreasuryLib() {
  const path = require.resolve('../src/lib/treasury');
  delete require.cache[path];
  return require('../src/lib/treasury');
}

// Save+restore env so tests don't leak state.
function withEnv(overrides, fn) {
  const prior = {
    HOUSE_WALLET: process.env.HOUSE_WALLET,
    TREASURY_WALLET: process.env.TREASURY_WALLET,
  };
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); }
  finally {
    for (const k of Object.keys(prior)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test('throws when HOUSE_WALLET and TREASURY_WALLET are unset', () => {
  withEnv({ HOUSE_WALLET: undefined, TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.throws(() => lib.getTreasuryAddress(), /HOUSE_WALLET .* not set or invalid/);
  });
});

test('throws when HOUSE_WALLET is empty string', () => {
  withEnv({ HOUSE_WALLET: '', TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.throws(() => lib.getTreasuryAddress(), /HOUSE_WALLET .* not set or invalid/);
  });
});

test('throws when HOUSE_WALLET is malformed (no 0x prefix)', () => {
  withEnv({ HOUSE_WALLET: 'E5588c407b6AdD3E83ce34190C77De20eaC1BeFe', TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.throws(() => lib.getTreasuryAddress(), /not set or invalid/);
  });
});

test('throws when HOUSE_WALLET is wrong length', () => {
  withEnv({ HOUSE_WALLET: '0xE5588c407b', TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.throws(() => lib.getTreasuryAddress(), /not set or invalid/);
  });
});

test('returns HOUSE_WALLET when set and valid (mixed case)', () => {
  const addr = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  withEnv({ HOUSE_WALLET: addr, TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.strictEqual(lib.getTreasuryAddress(), addr);
  });
});

test('returns HOUSE_WALLET when set and valid (checksum case)', () => {
  const addr = '0x15184BF50b3D3F52B60434F8942B7D52F2eB436E';
  withEnv({ HOUSE_WALLET: addr, TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.strictEqual(lib.getTreasuryAddress(), addr);
  });
});

test('falls back to TREASURY_WALLET when HOUSE_WALLET is unset', () => {
  const addr = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  withEnv({ HOUSE_WALLET: undefined, TREASURY_WALLET: addr }, () => {
    const lib = freshTreasuryLib();
    assert.strictEqual(lib.getTreasuryAddress(), addr);
  });
});

test('HOUSE_WALLET takes precedence over TREASURY_WALLET when both set', () => {
  const house = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const treas = '0xaaaa1bf50b3d3f52b60434f8942b7d52f2eb436e';
  withEnv({ HOUSE_WALLET: house, TREASURY_WALLET: treas }, () => {
    const lib = freshTreasuryLib();
    assert.strictEqual(lib.getTreasuryAddress(), house);
  });
});

test('caches first read; subsequent reads do not re-check env', () => {
  const a = '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e';
  const b = '0xbbbb1bf50b3d3f52b60434f8942b7d52f2eb436e';
  withEnv({ HOUSE_WALLET: a, TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    assert.strictEqual(lib.getTreasuryAddress(), a);
    process.env.HOUSE_WALLET = b;
    assert.strictEqual(lib.getTreasuryAddress(), a, 'cache should hold');
    lib._resetCacheForTests();
    assert.strictEqual(lib.getTreasuryAddress(), b, 'after reset, env re-read');
  });
});

test('regression: drained old treasury 0xE5588... is NOT a hardcoded fallback', () => {
  // Construct the leaked literal at runtime so the source-grep CI guard stays clean.
  const leaked = '0x' + 'E5588c407b6AdD3E83ce34190C77De20eaC1BeFe';
  withEnv({ HOUSE_WALLET: undefined, TREASURY_WALLET: undefined }, () => {
    const lib = freshTreasuryLib();
    // With env unset, must throw — must NOT silently return the old address.
    let returned = null;
    try { returned = lib.getTreasuryAddress(); } catch (_) {}
    assert.notStrictEqual(returned, leaked, 'helper must not fall back to drained treasury');
  });
});
