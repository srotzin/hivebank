// spectral-zk-auth.js — Spectral Zero-Knowledge Outbound Auth (SZOA).
//
// The defense layer designed in response to the 2026-04-25 incident.
//
// Patent novelty (extends Provisional #1 spectral compliance stamping +
// Provisional #10 spectral price oracle): bidirectional auth primitive whose
// validity window is bound to a live spectral epoch, such that even an
// attacker who exfiltrates EVERY hivebank secret cannot forge a single
// outbound ticket — because the signing key lives on a SEPARATE service
// (HiveTrust) that hivebank never sees.
//
// CONCEPT
// ───────
// Every outbound USDC send must carry a `spectral-zk-ticket` HTTP header
// containing a base64url JSON object:
//
//   {
//     "v":      1,                  // protocol version
//     "iss":    "did:hive:hivetrust-issuer-001",
//     "epoch":  "2026-04-25T07:55:00Z",  // 5-min UTC bucket
//     "regime": "NORMAL_CYAN",      // matches hivebank's live spectral classifier
//     "intent": "<sha256(to|amount|reason|did)>",
//     "nonce":  "<128-bit random>",
//     "exp":    "2026-04-25T08:00:00Z",
//     "sig":    "<ed25519(canonicalize(rest))>"
//   }
//
// A ticket is valid IFF:
//   1. The Ed25519 signature verifies under the published HiveTrust verifier
//      public key (env var SPECTRAL_VERIFIER_PK_B64U).
//   2. The `epoch` is within ±1 of hivebank's current epoch (5-min bucket).
//   3. The `regime` matches hivebank's *live* spectral classification of the
//      rolling outbound-amount window. Both sides classify independently —
//      the attacker cannot guess the regime ahead of time without insider
//      access to hivebank's running state.
//   4. The `intent` hash matches sha256 of the actual request body.
//   5. The `nonce` has not been seen before (single-use replay protection).
//   6. `exp` is in the future and ≤ 5 min from issuance.
//
// THREAT MODEL — what this kills
// ──────────────────────────────
//   ✓ Stolen HIVE_INTERNAL_KEY    → can call route, can't forge ticket
//   ✓ Stolen HIVE_WALLET_PRIVATE_KEY → can sign chain tx, but route blocks
//                                       before reaching the signer
//   ✓ Replay of a captured ticket  → nonce blocks; spectral epoch drifts
//   ✓ Precomputed ticket farm      → regime is unknowable in advance
//   ✓ Compromise of hivebank itself → verifier key is public; private key
//                                       lives only on HiveTrust signer host
//
// LIVENESS
// ────────
// If HiveTrust signer is down for a planned reason (maintenance), the
// `SPECTRAL_ZK_BYPASS=true` env var allows reverting to the existing
// allowlist+rate-limit defense. This is logged loudly and should only be
// flipped during incidents.

'use strict';

const crypto = require('crypto');
const ed = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha2');
const { canonicalize, canonicalBytes } = require('../lib/canonical');
const { classifyPriceWindow, REGIMES } = require('../lib/spectral');

// noble/ed25519 v2 sync hash provider
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

// ─── Config ──────────────────────────────────────────────────────────────────
const VERIFIER_PK_B64U = process.env.SPECTRAL_VERIFIER_PK_B64U || '';
const EPOCH_SEC        = parseInt(process.env.SPECTRAL_EPOCH_SEC || '300', 10);   // 5 min
const EPOCH_DRIFT      = parseInt(process.env.SPECTRAL_EPOCH_DRIFT || '1', 10);   // ±1 epochs
const TICKET_EXP_MAX_S = parseInt(process.env.SPECTRAL_TICKET_EXP_MAX || '300', 10); // 5 min
const NONCE_TTL_MS     = parseInt(process.env.SPECTRAL_NONCE_TTL_MS  || (10 * 60 * 1000).toString(), 10);
const BYPASS           = () => process.env.SPECTRAL_ZK_BYPASS === 'true';
const ENFORCE          = () => process.env.SPECTRAL_ZK_ENFORCE !== 'false';     // default ON

// ─── State ──────────────────────────────────────────────────────────────────
// Replay-protection nonce cache. Bounded to last NONCE_TTL_MS, capped at 50k
// entries to prevent memory blowup under attack.
const nonceSeen = new Map();   // nonce → expiry-ms
const NONCE_CAP = 50_000;

function pruneNonces() {
  const now = Date.now();
  for (const [n, exp] of nonceSeen) {
    if (exp < now) nonceSeen.delete(n);
  }
  // Hard cap — drop oldest entries
  if (nonceSeen.size > NONCE_CAP) {
    const overflow = nonceSeen.size - NONCE_CAP;
    let i = 0;
    for (const k of nonceSeen.keys()) {
      if (i++ >= overflow) break;
      nonceSeen.delete(k);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function bytesToB64u(b) {
  return Buffer.from(b).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64uToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const std = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(std, 'base64');
}

function currentEpoch(now = Date.now()) {
  // Bucketed UTC epoch ID: ISO timestamp truncated to EPOCH_SEC boundary.
  const bucketed = Math.floor(now / 1000 / EPOCH_SEC) * EPOCH_SEC;
  return new Date(bucketed * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function epochsApart(a, b) {
  const ta = Date.parse(a) / 1000;
  const tb = Date.parse(b) / 1000;
  return Math.abs(Math.round((ta - tb) / EPOCH_SEC));
}

function intentHash({ toAddress, amountUsdc, reason, hiveDid }) {
  const norm = canonicalize({
    to:     String(toAddress || '').toLowerCase(),
    amount: Number(amountUsdc).toFixed(6),
    reason: reason || '',
    did:    hiveDid || '',
  });
  return crypto.createHash('sha256').update(norm).digest('hex');
}

// Live regime — independently classified by hivebank from its own rolling
// window of outbound amounts (kept in outbound-guard.js).
// Caller passes the current ring (or empty for warmup). When in warmup the
// regime is `WARMUP` and tickets must declare `WARMUP` too.
function liveRegime(ring) {
  if (!Array.isArray(ring) || ring.length < 10) return 'WARMUP';
  return classifyPriceWindow(ring).regime;
}

// ─── Verify a ticket ────────────────────────────────────────────────────────
// Returns { ok, code, detail, telemetry? }.
async function verifyTicket(ticketB64u, intent_hex, recentRing) {
  // Bypass mode for declared maintenance windows
  if (BYPASS()) {
    return { ok: true, code: 'BYPASS', detail: 'SPECTRAL_ZK_BYPASS=true (audit this!)' };
  }

  if (!ENFORCE()) {
    return { ok: true, code: 'NOT_ENFORCED', detail: 'SPECTRAL_ZK_ENFORCE=false' };
  }

  if (!VERIFIER_PK_B64U) {
    return { ok: false, code: 'NO_VERIFIER_KEY',
             detail: 'SPECTRAL_VERIFIER_PK_B64U is not set on hivebank' };
  }
  if (!ticketB64u) {
    return { ok: false, code: 'NO_TICKET',
             detail: 'spectral-zk-ticket header is missing' };
  }

  let ticket;
  try {
    ticket = JSON.parse(b64uToBytes(ticketB64u).toString('utf8'));
  } catch (e) {
    return { ok: false, code: 'BAD_TICKET_ENCODING', detail: e.message };
  }

  // Required fields
  for (const k of ['v', 'iss', 'epoch', 'regime', 'intent', 'nonce', 'exp', 'sig']) {
    if (!(k in ticket)) {
      return { ok: false, code: 'MISSING_FIELD', detail: `ticket missing ${k}` };
    }
  }
  if (ticket.v !== 1) {
    return { ok: false, code: 'BAD_VERSION', detail: `ticket v=${ticket.v} (want 1)` };
  }

  // Epoch check
  const epNow = currentEpoch();
  if (epochsApart(ticket.epoch, epNow) > EPOCH_DRIFT) {
    return { ok: false, code: 'EPOCH_DRIFT',
             detail: `ticket.epoch=${ticket.epoch} now=${epNow} drift>${EPOCH_DRIFT}` };
  }

  // Expiry check
  const expMs = Date.parse(ticket.exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) {
    return { ok: false, code: 'EXPIRED',
             detail: `ticket.exp=${ticket.exp} (now ${new Date().toISOString()})` };
  }
  if (expMs - Date.now() > TICKET_EXP_MAX_S * 1000) {
    return { ok: false, code: 'EXP_TOO_LONG',
             detail: `ticket exp window > ${TICKET_EXP_MAX_S}s` };
  }

  // Intent hash check
  if (String(ticket.intent).toLowerCase() !== String(intent_hex).toLowerCase()) {
    return { ok: false, code: 'INTENT_MISMATCH',
             detail: `ticket.intent ≠ sha256(request)` };
  }

  // Live regime check — the spectral binding is the patent-novel piece.
  // A captured ticket from a different regime epoch is rejected.
  const live = liveRegime(recentRing);
  if (String(ticket.regime).toUpperCase() !== String(live).toUpperCase()) {
    return { ok: false, code: 'REGIME_MISMATCH',
             detail: `ticket.regime=${ticket.regime} live=${live}` };
  }

  // Replay check
  pruneNonces();
  if (nonceSeen.has(ticket.nonce)) {
    return { ok: false, code: 'NONCE_REPLAY',
             detail: `nonce ${ticket.nonce} already used` };
  }

  // Signature check — sign over canonicalized ticket minus `sig`
  const { sig, ...signed } = ticket;
  const bytes = canonicalBytes(signed);
  let sigOk;
  try {
    const pk = b64uToBytes(VERIFIER_PK_B64U);
    sigOk = await ed.verifyAsync(b64uToBytes(sig), bytes, pk);
  } catch (e) {
    return { ok: false, code: 'SIG_VERIFY_ERROR', detail: e.message };
  }
  if (!sigOk) {
    return { ok: false, code: 'BAD_SIGNATURE',
             detail: 'Ed25519 signature did not verify under SPECTRAL_VERIFIER_PK_B64U' };
  }

  // Commit nonce — single use
  nonceSeen.set(ticket.nonce, Date.now() + NONCE_TTL_MS);
  return {
    ok: true, code: 'OK',
    detail: `ticket valid (epoch=${ticket.epoch}, regime=${ticket.regime})`,
    telemetry: { iss: ticket.iss, epoch: ticket.epoch, regime: ticket.regime },
  };
}

// ─── Issuer-side helper (used by HiveTrust signer) ──────────────────────────
// Hivebank calls this only in tests/dev. Production signing happens on
// HiveTrust with a separate copy of this function. Kept here so the
// canonicalization stays bit-identical across implementations.
async function issueTicket({ issuerSk32, issuerDid, regime, intent_hex, expSec = 300 }) {
  const epoch = currentEpoch();
  const exp   = new Date(Date.now() + expSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = bytesToB64u(crypto.randomBytes(16));
  const ticket = {
    v: 1,
    iss: issuerDid,
    epoch,
    regime: String(regime).toUpperCase(),
    intent: intent_hex.toLowerCase(),
    nonce,
    exp,
  };
  const bytes = canonicalBytes(ticket);
  const sig = await ed.signAsync(bytes, issuerSk32);
  ticket.sig = bytesToB64u(sig);
  return bytesToB64u(Buffer.from(canonicalize(ticket), 'utf8'));
}

function snapshot() {
  return {
    enforced: ENFORCE(),
    bypass:   BYPASS(),
    verifier_set: !!VERIFIER_PK_B64U,
    epoch_sec: EPOCH_SEC,
    epoch_drift: EPOCH_DRIFT,
    nonce_cache: nonceSeen.size,
    nonce_cache_cap: NONCE_CAP,
    nonce_ttl_ms: NONCE_TTL_MS,
    current_epoch: currentEpoch(),
    valid_regimes: REGIMES.map(r => r.name),
  };
}

module.exports = {
  verifyTicket,
  issueTicket,
  intentHash,
  currentEpoch,
  liveRegime,
  snapshot,
};
