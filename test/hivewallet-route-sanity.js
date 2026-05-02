// In-process route sanity for hivewallet.js with HiveDNA wired.
// Stubs db, vault, usdc-transfer, outbound-guard so we can hit the routes
// over a local listener without a real Postgres or Base RPC.

'use strict';

const path = require('path');

// In-memory db
const tables = {};
const dbStub = {
  run: async (sql, params) => {
    const m = sql.match(/INSERT INTO (\w+)/i);
    if (m) {
      const t = m[1];
      if (!tables[t]) tables[t] = [];
      tables[t].push({ __sql: sql, __params: params });
    }
    if (/^UPDATE hivewallet_wallets/i.test(sql)) {
      const did = params[1];
      const w = (tables.hivewallet_wallets || []).find(r => r.__params[0] === did);
      if (w) w.__params[7] = (parseFloat(w.__params[7] || 0) + parseFloat(params[0])).toString();
    }
    return { rowCount: 1 };
  },
  getOne: async (sql, params) => {
    if (/FROM hivewallet_wallets WHERE did=\$1/.test(sql)) {
      const did = params[0];
      const r = (tables.hivewallet_wallets || []).find(x => x.__params[0] === did);
      if (!r) return null;
      const p = r.__params;
      return {
        did: p[0], wallet_id: p[1], display_name: p[2], evm_address: p[3], aleo_address: p[4],
        rail_preference: p[5], total_sent_usdc: 0, total_recv_usdc: 0, tx_count: 0, status: 'active',
        created_at: new Date(), last_active: new Date(),
      };
    }
    if (/FROM hivewallet_policies WHERE did=\$1/.test(sql)) {
      // No policy — let defaults pass
      return { max_per_tx_usdc: 1000, max_per_hour_usdc: 5000, max_per_day_usdc: 25000 };
    }
    if (/COALESCE\(SUM\(amount_usdc.*1 hour/.test(sql)) return { spent: 0 };
    if (/COALESCE\(SUM\(amount_usdc.*24 hours/.test(sql)) return { spent: 0, daily_sent: 0 };
    if (/FROM hivewallet_receipts WHERE receipt_id=\$1/.test(sql)) {
      const r = (tables.hivewallet_receipts || []).find(x => x.__params[0] === params[0]);
      if (!r) return null;
      const p = r.__params;
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
    if (/FROM hivewallet_ctef_chain[\s\S]*ORDER BY position DESC LIMIT 1/.test(sql)) {
      const did = params[0];
      const rows = (tables.hivewallet_ctef_chain || [])
        .filter(r => r.__params[0] === did)
        .map(r => ({ position: r.__params[1], entry_hash: r.__params[5] }))
        .sort((a, b) => b.position - a.position);
      return rows[0] || null;
    }
    if (/FROM hivewallet_ctef_chain\s*\n*\s*WHERE entry_hash=\$1/.test(sql)) {
      const eh = params[0];
      const r = (tables.hivewallet_ctef_chain || []).find(x => x.__params[5] === eh);
      if (!r) return null;
      return { prev_hash: r.__params[4], entry_hash: r.__params[5], payload_json: r.__params[6] };
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

// Patch require cache for db, vault, usdc-transfer, outbound-guard, internal-key
function patch(modPath, exports_) {
  const abs = path.resolve(__dirname, modPath);
  require.cache[abs] = { exports: exports_, id: abs, filename: abs, loaded: true };
}

patch('../src/services/db.js', dbStub);
patch('../src/services/vault.js', {
  createVault: async () => ({}),
  getVault: async () => ({ balance_usdc: 100, yield_earned_usdc: 0 }),
  withdraw: async (did, amount) => ({ balance_after: 100 - amount }),
  deposit: async () => ({}),
});
patch('../src/services/usdc-transfer.js', {
  sendUSDC: async (to, amt) => ({ ok: true, txHash: '0x' + 'a'.repeat(64), to, amount: amt }),
  checkUSDCBalance: async () => 100,
});
patch('../src/services/outbound-guard.js', {
  getRecentRing: () => [],
  checkOutbound: async () => ({ ok: true, layers_passed: ['L0','L1','L2','L3','L4','L5'] }),
});
patch('../src/lib/internal-key.js', {
  getInternalKey: () => 'sanity-internal-key-1234',
});

process.env.SPECTRAL_ZK_ENFORCE = 'false';

const express = require('express');
const router = require('../src/routes/hivewallet');

const app = express();
app.use(express.json());
app.use('/v1/wallet', router);

const server = app.listen(0, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, p, body, headers = {}) {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let j;
    try { j = JSON.parse(text); } catch (_) { j = { __raw: text.slice(0, 400) }; }
    return { status: res.status, body: j };
  }

  const did = 'did:hive:sanity-001';

  console.log('— GET /v1/wallet/info —');
  let r = await call('GET', '/v1/wallet/info');
  console.log('status:', r.status, 'hivedna:', r.body.hivedna);

  console.log('\n— POST /v1/wallet/create —');
  r = await call('POST', '/v1/wallet/create', { did, evm_address: '0x' + '1'.repeat(40) });
  console.log('status:', r.status, 'wallet_id:', r.body.wallet_id);

  console.log('\n— POST /v1/wallet/:did/send —');
  r = await call('POST', `/v1/wallet/${encodeURIComponent(did)}/send`, {
    to_address: '0x' + 'b'.repeat(40),
    amount_usdc: 1.5,
    memo: 'sanity test',
  }, { 'x-hive-did': did });
  console.log('status:', r.status);
  console.log('tx_id:', r.body.tx_id);
  console.log('hivedna.receipt_id:', r.body.hivedna?.receipt_id);
  console.log('hivedna.score:', r.body.hivedna?.hivedna_score);
  console.log('hivedna.proofs.shod.cleared:', r.body.hivedna?.proofs?.shod?.cleared);
  console.log('hivedna.proofs.ctef.position:', r.body.hivedna?.proofs?.ctef?.position);
  const receiptId = r.body.hivedna?.receipt_id;

  console.log('\n— GET /v1/wallet/verify/:receipt_id (PUBLIC, no auth) —');
  r = await call('GET', `/v1/wallet/verify/${receiptId}`);
  console.log('status:', r.status);
  console.log('found:', r.body.found);
  console.log('signature_valid:', r.body.signature_valid);
  console.log('body_hash_matches:', r.body.body_hash_matches);
  console.log('ctef_chain_intact:', r.body.ctef_chain_intact);
  console.log('verifier_pk:', r.body.verifier_pk_b64u);

  console.log('\n— GET /v1/wallet/:did/chain (PUBLIC, no auth) —');
  r = await call('GET', `/v1/wallet/${encodeURIComponent(did)}/chain`);
  console.log('status:', r.status);
  console.log('chain_length:', r.body.chain_length);
  console.log('chain_intact:', r.body.chain_intact);
  console.log('latest_hash:', r.body.latest_hash?.slice(0,16) + '…');

  console.log('\n— GET /v1/wallet/verify/rcpt_does_not_exist —');
  r = await call('GET', '/v1/wallet/verify/rcpt_doesnotexist');
  console.log('status:', r.status, 'found:', r.body.found);

  console.log('\n— send a 2nd tx to test chain extension —');
  r = await call('POST', `/v1/wallet/${encodeURIComponent(did)}/send`, {
    to_address: '0x' + 'c'.repeat(40),
    amount_usdc: 0.25,
  }, { 'x-hive-did': did });
  console.log('2nd ctef position:', r.body.hivedna?.proofs?.ctef?.position);

  r = await call('GET', `/v1/wallet/${encodeURIComponent(did)}/chain`);
  console.log('chain_length after 2 tx:', r.body.chain_length, 'intact:', r.body.chain_intact);

  console.log('\nALL ROUTE SANITY OK');
  server.close();
})
.on('error', e => { console.error(e); process.exit(1); });
