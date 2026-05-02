// Quick local sanity test for hivedna-receipt.js
// Uses an in-memory shim for ../services/db so we don't need a real Postgres.

'use strict';

// In-memory db shim
const tables = {};
function fakeDb() {
  return {
    run: async (sql, params) => {
      // ultra-minimal: we only care that INSERTs round-trip via getOne / getAll
      // Track the last INSERT into each table by a simple key.
      const m = sql.match(/INSERT INTO (\w+)/i);
      if (m) {
        const t = m[1];
        if (!tables[t]) tables[t] = [];
        // For our two tables, we know the column order; capture by position.
        tables[t].push({ __sql: sql, __params: params });
      }
      // CREATE TABLE / CREATE INDEX silently succeed
      return { rowCount: 1 };
    },
    getOne: async (sql, params) => {
      // hivewallet_receipts SELECT *
      if (/FROM hivewallet_receipts WHERE receipt_id=\$1/.test(sql)) {
        const found = (tables.hivewallet_receipts || []).find(r => r.__params[0] === params[0]);
        if (!found) return null;
        const p = found.__params;
        return {
          receipt_id: p[0], tx_id: p[1], from_did: p[2], to_did: p[3], to_address: p[4],
          amount_usdc: p[5], rail: p[6],
          shod_layers: p[7], shod_cleared: p[8], receipt_body_canon: p[9],
          spectral_attached: p[10], spectral_iss: p[11], spectral_epoch: p[12],
          spectral_regime: p[13], spectral_ticket_hash: p[14],
          ctef_position: p[15], ctef_prev_hash: p[16], ctef_entry_hash: p[17],
          hivedna_score: p[18], receipt_body_hash: p[19], signature: p[20], verifier_pk: p[21],
          created_at: new Date(),
        };
      }
      // ctef chain — last position
      if (/FROM hivewallet_ctef_chain[\s\S]*ORDER BY position DESC LIMIT 1/.test(sql)) {
        const did = params[0];
        const rows = (tables.hivewallet_ctef_chain || [])
          .filter(r => r.__params[0] === did)
          .map(r => ({ position: r.__params[1], entry_hash: r.__params[5] }))
          .sort((a, b) => b.position - a.position);
        return rows[0] || null;
      }
      // ctef chain by entry_hash
      if (/FROM hivewallet_ctef_chain\s*\n*\s*WHERE entry_hash=\$1/.test(sql)) {
        const eh = params[0];
        const found = (tables.hivewallet_ctef_chain || []).find(r => r.__params[5] === eh);
        if (!found) return null;
        return { prev_hash: found.__params[4], entry_hash: found.__params[5], payload_json: found.__params[6] };
      }
      return null;
    },
    getAll: async (sql, params) => {
      if (/FROM hivewallet_ctef_chain[\s\S]*WHERE did=\$1[\s\S]*ORDER BY position ASC/.test(sql)) {
        const did = params[0];
        return (tables.hivewallet_ctef_chain || [])
          .filter(r => r.__params[0] === did)
          .map(r => ({
            position: r.__params[1],
            prev_hash: r.__params[4],
            entry_hash: r.__params[5],
            payload_json: r.__params[6],
            created_at: new Date(),
          }))
          .sort((a, b) => a.position - b.position);
      }
      return [];
    },
  };
}

// Patch require cache
const path = require('path');
const dbPath = path.resolve(__dirname, '../src/services/db.js');
require.cache[dbPath] = { exports: fakeDb(), id: dbPath, filename: dbPath, loaded: true };

// Minimal HIVE_INTERNAL_KEY for derived signer
process.env.HIVE_INTERNAL_KEY = 'test-internal-key-for-hivedna-sanity';
process.env.SPECTRAL_ZK_ENFORCE = 'false'; // skip ticket sig verify for this sanity test

const hivedna = require('../src/services/hivedna-receipt');

(async () => {
  console.log('— minting receipt —');
  const r1 = await hivedna.mintReceipt({
    from_did: 'did:hive:test-001',
    to_did: 'did:hive:dest-001',
    to_address: '0x' + 'a'.repeat(40),
    amount_usdc: 1.234567,
    rail: 'usdc',
    tx_id: 'hwtx_' + 'b'.repeat(20),
    on_chain: { txHash: '0x' + 'c'.repeat(64) },
    spectral_ticket_b64u: null,
    recent_ring: [],
  });
  console.log('receipt_id:', r1.receipt_id);
  console.log('hivedna_score:', r1.hivedna_score);
  console.log('signature:', r1.signature.slice(0, 32) + '…');
  console.log('verifier_pk:', r1.verifier_pk_b64u);
  console.log('ctef position:', r1.proofs.ctef.position);

  console.log('\n— minting second receipt (chain extends) —');
  const r2 = await hivedna.mintReceipt({
    from_did: 'did:hive:test-001',
    to_did: null,
    to_address: '0x' + 'd'.repeat(40),
    amount_usdc: 0.5,
    rail: 'usdc',
    tx_id: 'hwtx_' + 'e'.repeat(20),
    on_chain: null,
    spectral_ticket_b64u: null,
    recent_ring: [],
  });
  console.log('receipt2 ctef position:', r2.proofs.ctef.position);
  console.log('receipt2 prev_hash matches r1 entry_hash?',
    r2.proofs.ctef.prev_hash === r1.proofs.ctef.entry_hash);

  console.log('\n— verifying receipt 1 —');
  const v = await hivedna.verifyReceipt(r1.receipt_id);
  console.log('found:', v.found);
  console.log('signature_valid:', v.signature_valid);
  console.log('body_hash_matches:', v.body_hash_matches);
  console.log('ctef_chain_intact:', v.ctef_chain_intact);

  console.log('\n— chain integrity for did —');
  const ci = await hivedna.chainIntegrity('did:hive:test-001');
  console.log('chain_length:', ci.chain_length);
  console.log('chain_intact:', ci.chain_intact);
  console.log('latest_hash:', ci.latest_hash);

  console.log('\n— verifying nonexistent receipt —');
  const v2 = await hivedna.verifyReceipt('rcpt_nonexistent');
  console.log('found:', v2.found);

  console.log('\nALL OK');
})().catch(e => { console.error('SANITY FAIL:', e); process.exit(1); });
