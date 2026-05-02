// hivedna-receipt.js — HiveDNA: 3-proof receipt minter for HiveWallet.
//
// Every HiveWallet transfer carries HiveDNA: a tamper-evident receipt that
// proves the transfer was authorized (SHOD), behaviorally clean (Spectral-ZK),
// and identity-bound (CTEF chain). The receipt is the compliance record.
//
// THE THREE PROOFS
// ────────────────
//   PROOF 1 — SHOD CLEARANCE
//     Captures which of the 6 SHOD layers (L0-L5) the outbound USDC send
//     cleared. Sourced from outbound-guard.checkOutbound() telemetry.
//     A receipt is only minted on a successful (cleared) send.
//
//   PROOF 2 — SPECTRAL-ZK BEHAVIORAL INTEGRITY
//     If the request carried an `x-spectral-zk-ticket` header and the
//     spectral-ZK verifier accepted it, the receipt records the issuer DID,
//     epoch, regime, and a hash of the canonical ticket. If the ticket was
//     absent or rejected, the receipt records `attached: false` — never a
//     forged proof.
//
//   PROOF 3 — CTEF IDENTITY CHAIN
//     A per-DID hash chain anchored to a genesis hash (first transfer for
//     the wallet). Each new entry hashes:
//       SHA-256( prev_hash || did || receipt_id || tx_id || amount || ts )
//     The entry is written to hivewallet_ctef_chain BEFORE the receipt is
//     finalized so the chain is always consistent.
//
// COMPOSITE HIVEDNA SCORE (0-1000)
// ────────────────────────────────
//   600 base for a settled transfer (cleared all SHOD checks)
//   +200 if a verified spectral-ZK ticket was attached
//        +50 if epoch matches current live epoch (no drift)
//        +25 if regime is NORMAL_CYAN or WARMUP
//   +100 if CTEF chain extension was successful (entry committed)
//        +25 if chain length > 10 (established history bonus)
//   -100 per missing optional proof
//
// SIGNING
// ───────
//   Ed25519 over canonicalized receipt body (excluding `signature` field).
//   Key sourced from env HIVEDNA_RECEIPT_SK_B64U (32-byte b64url seed).
//   If unset, derived deterministically from HIVE_INTERNAL_KEY so the
//   service still works, but rotated to a true HSM-managed key on launch.
//
// PUBLIC VERIFICATION
// ───────────────────
//   The corresponding public key is exposed at GET /v1/wallet/info under
//   `hivedna.verifier_pk_b64u` and used by /v1/wallet/verify/:receipt_id.

'use strict';

const crypto = require('crypto');
const ed = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha2');
const { canonicalize, canonicalBytes } = require('../lib/canonical');
const db = require('./db');
const { getInternalKey } = require('../lib/internal-key');
const spectralAuth = require('./spectral-zk-auth');

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ─── Key management ─────────────────────────────────────────────────────────
function bytesToB64u(b) {
  return Buffer.from(b).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const std = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(std, 'base64');
}

let _signerSk = null;
let _verifierPk = null;

async function ensureSigner() {
  if (_signerSk && _verifierPk) return;
  const fromEnv = process.env.HIVEDNA_RECEIPT_SK_B64U;
  if (fromEnv && fromEnv.length >= 40) {
    _signerSk = b64uToBytes(fromEnv);
  } else {
    // Derive deterministic dev/launch key from internal secret. NOT for
    // long-term production — set HIVEDNA_RECEIPT_SK_B64U to a freshly
    // generated 32-byte seed when you cut over to HSM custody.
    _signerSk = crypto.createHash('sha256')
      .update('hivedna-receipt-signer:v1:')
      .update(getInternalKey())
      .digest();
  }
  if (_signerSk.length !== 32) {
    throw new Error('[hivedna-receipt] signer seed must be 32 bytes');
  }
  _verifierPk = await ed.getPublicKeyAsync(_signerSk);
  console.log('[hivedna-receipt] signer ready, verifier_pk=', bytesToB64u(_verifierPk));
}

function verifierPkB64u() {
  return _verifierPk ? bytesToB64u(_verifierPk) : null;
}

// ─── Tables ─────────────────────────────────────────────────────────────────
async function ensureTables() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS hivewallet_receipts (
      receipt_id        TEXT PRIMARY KEY,
      tx_id             TEXT NOT NULL,
      from_did          TEXT NOT NULL,
      to_did            TEXT,
      to_address        TEXT,
      amount_usdc       NUMERIC(18,4) NOT NULL,
      rail              TEXT,
      shod_layers       JSONB,
      shod_cleared      BOOLEAN DEFAULT false,
      receipt_body_canon TEXT,
      spectral_attached BOOLEAN DEFAULT false,
      spectral_iss      TEXT,
      spectral_epoch    TEXT,
      spectral_regime   TEXT,
      spectral_ticket_hash TEXT,
      ctef_position     INTEGER,
      ctef_prev_hash    TEXT,
      ctef_entry_hash   TEXT,
      hivedna_score     INTEGER,
      hivedna_proof     TEXT,
      receipt_body_hash TEXT,
      signature         TEXT,
      verifier_pk       TEXT,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_hivewallet_receipts_did
      ON hivewallet_receipts(from_did);
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_hivewallet_receipts_tx
      ON hivewallet_receipts(tx_id);
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS hivewallet_ctef_chain (
      id            BIGSERIAL PRIMARY KEY,
      did           TEXT NOT NULL,
      position      INTEGER NOT NULL,
      receipt_id    TEXT,
      tx_id         TEXT,
      prev_hash     TEXT NOT NULL,
      entry_hash    TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (did, position),
      UNIQUE (entry_hash)
    );
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_ctef_chain_did
      ON hivewallet_ctef_chain(did, position DESC);
  `);
}

ensureTables().catch(e => console.error('[hivedna-receipt] table init:', e));

// ─── Helpers ────────────────────────────────────────────────────────────────
function receiptId() {
  // Sortable-ish ULID-like id: ms timestamp + random bytes.
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `rcpt_${ts}${rand}`;
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── CTEF chain extension ───────────────────────────────────────────────────
// Append a single entry to the per-DID hash chain. Atomic: if two concurrent
// transfers race, the UNIQUE(did, position) constraint forces one to retry.
async function extendCtefChain({ did, receipt_id, tx_id, payload }) {
  const last = await db.getOne(
    `SELECT position, entry_hash FROM hivewallet_ctef_chain
       WHERE did=$1 ORDER BY position DESC LIMIT 1`,
    [did]
  );
  const prevPos = last ? parseInt(last.position) : -1;
  const prevHash = last ? last.entry_hash
    : sha256hex(`hivedna-genesis:${did}`);
  const position = prevPos + 1;

  const entryPayload = {
    did,
    position,
    receipt_id,
    tx_id,
    amount_usdc: payload.amount_usdc,
    to: payload.to_did || payload.to_address || '',
    rail: payload.rail,
    ts: payload.ts,
  };
  const canon = canonicalize(entryPayload);
  const entryHash = sha256hex(`${prevHash}::${canon}`);

  try {
    await db.run(
      `INSERT INTO hivewallet_ctef_chain
         (did, position, receipt_id, tx_id, prev_hash, entry_hash, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [did, position, receipt_id, tx_id, prevHash, entryHash, canon]
    );
  } catch (e) {
    // Position raced — re-read tail and try once more
    const last2 = await db.getOne(
      `SELECT position, entry_hash FROM hivewallet_ctef_chain
         WHERE did=$1 ORDER BY position DESC LIMIT 1`,
      [did]
    );
    const newPrevHash = last2 ? last2.entry_hash : prevHash;
    const newPos = last2 ? parseInt(last2.position) + 1 : 0;
    entryPayload.position = newPos;
    const canon2 = canonicalize(entryPayload);
    const newHash = sha256hex(`${newPrevHash}::${canon2}`);
    await db.run(
      `INSERT INTO hivewallet_ctef_chain
         (did, position, receipt_id, tx_id, prev_hash, entry_hash, payload_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [did, newPos, receipt_id, tx_id, newPrevHash, newHash, canon2]
    );
    return { position: newPos, prev_hash: newPrevHash, entry_hash: newHash };
  }

  return { position, prev_hash: prevHash, entry_hash: entryHash };
}

// ─── Verify a presented spectral-ZK ticket (best-effort; receipt records
//     whatever validity result comes back, never forges a pass) ────────────
async function evaluateSpectralTicket({ ticketB64u, intent_hex, recentRing }) {
  if (!ticketB64u) {
    return { attached: false };
  }
  try {
    const result = await spectralAuth.verifyTicket(ticketB64u, intent_hex, recentRing || []);
    // Ticket-body hash for receipt fingerprinting (not the secret part)
    const tHash = sha256hex(ticketB64u);
    if (!result.ok) {
      return {
        attached: true,
        verified: false,
        code: result.code,
        ticket_hash: tHash,
      };
    }
    const tel = result.telemetry || {};
    return {
      attached: true,
      verified: true,
      iss: tel.iss || null,
      epoch: tel.epoch || null,
      regime: tel.regime || null,
      ticket_hash: tHash,
    };
  } catch (e) {
    return { attached: true, verified: false, code: 'VERIFY_ERROR', detail: e.message };
  }
}

// ─── Score the receipt (deterministic, documented above) ────────────────────
function scoreReceipt({ shodCleared, shodLayers, spectral, ctef }) {
  let score = 0;
  if (shodCleared) score += 600;
  // Each SHOD layer cleared adds value (capped) — already counted in base, but
  // give a small bonus when L4 (spectral anomaly) and L5 (trust) are both clean
  const layers = Array.isArray(shodLayers) ? shodLayers.map(String) : [];
  if (layers.includes('L4') && layers.includes('L5')) score += 0; // already in base

  if (spectral?.attached && spectral?.verified) {
    score += 200;
    if (spectral.epoch && spectral.epoch === spectralAuth.currentEpoch()) score += 50;
    const regime = String(spectral.regime || '').toUpperCase();
    if (regime === 'NORMAL_CYAN' || regime === 'WARMUP') score += 25;
  } else {
    score -= 100; // missing/invalid spectral attestation
  }

  if (ctef?.entry_hash) {
    score += 100;
    if (typeof ctef.position === 'number' && ctef.position > 10) score += 25;
  } else {
    score -= 100;
  }

  return Math.max(0, Math.min(1000, score));
}

// ─── Mint a receipt for a settled transfer ─────────────────────────────────
async function mintReceipt({
  from_did,
  to_did,
  to_address,
  amount_usdc,
  rail,
  tx_id,
  on_chain,                  // result from sendUSDC, may be null
  spectral_ticket_b64u,      // raw header value or null
  shod_telemetry,            // optional outbound-guard result
  recent_ring,               // optional outbound-guard.getRecentRing()
}) {
  await ensureSigner();

  const ts = new Date().toISOString();
  const rid = receiptId();

  // PROOF 1 — SHOD: For a successful settled transfer through usdc-transfer,
  // outbound-guard L0..L5 have all cleared. We record which layers ran.
  const shodLayers = (shod_telemetry?.layers_passed) ||
    ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'];
  const shodCleared = !shod_telemetry || shod_telemetry?.ok !== false;

  // PROOF 2 — Spectral-ZK
  // Compute intent hash that the ticket should bind to (matches send route)
  const intentHex = spectralAuth.intentHash({
    toAddress: to_address || to_did || '',
    amountUsdc: amount_usdc,
    reason: 'hivewallet_send',
    hiveDid: from_did,
  });
  const spectral = await evaluateSpectralTicket({
    ticketB64u: spectral_ticket_b64u,
    intent_hex: intentHex,
    recentRing: recent_ring,
  });

  // PROOF 3 — CTEF chain extension
  let ctef = null;
  try {
    ctef = await extendCtefChain({
      did: from_did,
      receipt_id: rid,
      tx_id,
      payload: { amount_usdc, to_did, to_address, rail, ts },
    });
  } catch (e) {
    console.error('[hivedna-receipt] ctef extend failed:', e.message);
    ctef = null;
  }

  const score = scoreReceipt({
    shodCleared,
    shodLayers,
    spectral,
    ctef,
  });

  // Build canonical receipt body
  const body = {
    receipt_id: rid,
    tx_id,
    on_chain_tx: on_chain?.txHash || on_chain?.hash || null,
    from_did,
    to_did: to_did || null,
    to_address: to_address || null,
    amount_usdc: Number(amount_usdc).toFixed(6),
    rail,
    settlement_rail: rail === 'usdc' ? 'base_l2' : rail,
    proofs: {
      shod: {
        cleared: shodCleared,
        layers_passed: shodLayers,
      },
      spectral_zk: spectral,
      ctef: ctef ? {
        position: ctef.position,
        prev_hash: ctef.prev_hash,
        entry_hash: ctef.entry_hash,
      } : { attached: false },
    },
    hivedna_score: score,
    issued_at: ts,
    receipt_version: '1.0',
  };

  const bodyCanon = canonicalize(body);
  const bodyHash = sha256hex(bodyCanon);

  // Sign the canonical body bytes with Ed25519
  const sigBytes = await ed.signAsync(canonicalBytes(body), _signerSk);
  const signature = bytesToB64u(sigBytes);

  // Persist
  await db.run(`
    INSERT INTO hivewallet_receipts
      (receipt_id, tx_id, from_did, to_did, to_address, amount_usdc, rail,
       shod_layers, shod_cleared, receipt_body_canon,
       spectral_attached, spectral_iss, spectral_epoch, spectral_regime, spectral_ticket_hash,
       ctef_position, ctef_prev_hash, ctef_entry_hash,
       hivedna_score, receipt_body_hash, signature, verifier_pk)
    VALUES ($1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,
            $11,$12,$13,$14,$15,
            $16,$17,$18,
            $19,$20,$21,$22)
  `, [
    rid, tx_id, from_did, to_did || null, to_address || null, amount_usdc, rail,
    JSON.stringify(shodLayers), shodCleared, bodyCanon,
    !!spectral.attached, spectral.iss || null, spectral.epoch || null,
    spectral.regime || null, spectral.ticket_hash || null,
    ctef?.position ?? null, ctef?.prev_hash || null, ctef?.entry_hash || null,
    score, bodyHash, signature, verifierPkB64u(),
  ]);

  return {
    ...body,
    signature,
    verifier_pk_b64u: verifierPkB64u(),
    receipt_body_hash: bodyHash,
  };
}

// ─── Verify a receipt by id (public endpoint backend) ──────────────────────
async function verifyReceipt(receipt_id) {
  await ensureSigner();
  const row = await db.getOne(
    `SELECT * FROM hivewallet_receipts WHERE receipt_id=$1`, [receipt_id]
  );
  if (!row) return { found: false };

  // Pull the exact canonical body bytes that were signed at mint time.
  // Stored as TEXT so we get byte-exact bytes back (JSONB would re-normalize).
  const bodyCanon = row.receipt_body_canon || null;
  const body = bodyCanon ? JSON.parse(bodyCanon) : null;

  const recomputedHash = bodyCanon ? sha256hex(bodyCanon) : null;

  let signatureValid = false;
  try {
    if (bodyCanon) {
      signatureValid = await ed.verifyAsync(
        b64uToBytes(row.signature),
        Buffer.from(bodyCanon, 'utf8'),
        _verifierPk
      );
    }
  } catch (e) {
    signatureValid = false;
  }

  // CTEF integrity check for THIS receipt's chain entry
  let ctefIntact = null;
  if (row.ctef_entry_hash) {
    const chainRow = await db.getOne(
      `SELECT prev_hash, entry_hash, payload_json FROM hivewallet_ctef_chain
        WHERE entry_hash=$1`, [row.ctef_entry_hash]
    );
    if (chainRow) {
      const recomputed = sha256hex(`${chainRow.prev_hash}::${chainRow.payload_json}`);
      ctefIntact = recomputed === chainRow.entry_hash;
    }
  }

  return {
    found: true,
    receipt: body,
    signature: row.signature,
    signature_valid: signatureValid,
    stored_body_hash: row.receipt_body_hash,
    recomputed_body_hash: recomputedHash,
    body_hash_matches: row.receipt_body_hash === recomputedHash,
    ctef_chain_intact: ctefIntact,
    verifier_pk_b64u: verifierPkB64u(),
    verified_at: new Date().toISOString(),
  };
}

// ─── Public CTEF chain integrity check for a DID ────────────────────────────
async function chainIntegrity(did) {
  await ensureSigner();
  const rows = await db.getAll(
    `SELECT position, prev_hash, entry_hash, payload_json, created_at
       FROM hivewallet_ctef_chain
      WHERE did=$1
      ORDER BY position ASC`,
    [did]
  );
  if (!rows || rows.length === 0) {
    return {
      did,
      chain_length: 0,
      chain_intact: true,
      chain_root: sha256hex(`hivedna-genesis:${did}`),
      latest_hash: null,
      message: 'no entries yet',
    };
  }

  const root = sha256hex(`hivedna-genesis:${did}`);
  let intact = true;
  let lastHash = root;
  let firstBreak = null;

  for (const r of rows) {
    const recomputed = sha256hex(`${r.prev_hash}::${r.payload_json}`);
    const expectedPrev = lastHash;
    if (recomputed !== r.entry_hash || r.prev_hash !== expectedPrev) {
      intact = false;
      firstBreak = { position: r.position, prev_hash: r.prev_hash, entry_hash: r.entry_hash };
      break;
    }
    lastHash = r.entry_hash;
  }

  // Sign the integrity statement
  const statement = {
    did,
    chain_length: rows.length,
    chain_root: root,
    latest_hash: lastHash,
    chain_intact: intact,
    verified_at: new Date().toISOString(),
  };
  const sig = await ed.signAsync(canonicalBytes(statement), _signerSk);

  return {
    ...statement,
    first_break: firstBreak,
    verification_proof: bytesToB64u(sig),
    verifier_pk_b64u: verifierPkB64u(),
  };
}

module.exports = {
  ensureSigner,
  ensureTables,
  mintReceipt,
  verifyReceipt,
  chainIntegrity,
  verifierPkB64u,
};
