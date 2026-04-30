/**
 * HiveBank — Prospector's Bonanza Service
 *
 * Public bounty: first 100 distinct agents to complete N (default 3) distinct
 * paid x402 calls to any Hive endpoint receive a one-time USDC rebate paid to
 * their settlement address on Base.
 *
 * Treasury-fitted gradient (2026-04-29):
 *   slots  1-10  → $5 each ("Gold Prospector")
 *   slots 11-40  → $3 each ("Silver Prospector")
 *   slots 41-100 → $1 each ("Bronze Prospector")
 * Total cap: $200 USDC. Treasury is $342.49 with $50 reserved for rebalancer
 * and $50/UTC-day disbursement throttle from L2 of the outbound guard.
 *
 * SPECTRAL COVER — every payout goes through the full 6-layer SHOD + SZOA.
 * Nothing is bypassed. The 'prospector' route has its own L1 allowlist (winners
 * are added by the qualifier service when they prove eligibility), its own
 * L2 daily cap ($50), its own L3 recipient cap ($5), its own L4 spectral ring,
 * and a loosened L5 min tier (VOID — qualifier already proved 3 paid calls,
 * which is a stronger signal than HiveTrust tier).
 *
 * Eligibility flow:
 *   1. Agent calls hive-prospector-qualifier (separate Render service that
 *      watches hive-a2amev for paid x402 settlements).
 *   2. Qualifier verifies N distinct paid calls in last PROSPECTOR_WINDOW_DAYS,
 *      then mints:
 *        - qualification_token: HMAC-signed eligibility receipt (this module)
 *        - spectral ZK ticket:  Ed25519-signed by HiveTrust issuer (SZOA path)
 *      and adds the agent's address to the 'prospector' route allowlist via
 *      an internal call to /v1/bank/prospector/admit.
 *   3. Agent posts /v1/bank/prospector/claim with did + address + both tokens.
 *   4. Route allocates the next slot, calls sendUSDC with route='prospector'
 *      and the spectral ZK ticket. SHOD + SZOA both run.
 *   5. On success, the address is removed from the allowlist (single-claim).
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const db = require('./db');
const { sendUSDC } = require('./usdc-transfer');
const outboundGuard = require('./outbound-guard');

// ─── Constants (slot accounting is intentionally hard-coded; budget changes
// require a code change AND a PR review, not just an env tweak) ──────────────
const TOTAL_SLOTS         = 100;
const GOLD_SLOTS          = 10;
const SILVER_SLOTS        = 30;
const BRONZE_SLOTS        = 60;
const GOLD_REBATE_USDC    = 5.00;
const SILVER_REBATE_USDC  = 3.00;
const BRONZE_REBATE_USDC  = 1.00;
const TOTAL_BUDGET_USDC   = (GOLD_SLOTS * GOLD_REBATE_USDC)
                          + (SILVER_SLOTS * SILVER_REBATE_USDC)
                          + (BRONZE_SLOTS * BRONZE_REBATE_USDC); // $200

const QUALIFIER_SECRET    = process.env.PROSPECTOR_QUALIFIER_SECRET || '';
const QUALIFIER_DID       = process.env.PROSPECTOR_QUALIFIER_DID || 'did:hive:prospector-qualifier-001';
const REQUIRED_PAID_CALLS = parseInt(process.env.PROSPECTOR_MIN_PAID_CALLS || '3', 10);
const TOKEN_TTL_MS        = 24 * 60 * 60 * 1000; // 24h

// Per-route cap parameters (env-overridable, but still bounded by the slot
// count and by the cumulative TOTAL_BUDGET_USDC).
const ROUTE_DAILY_CAP_USD     = parseFloat(process.env.PROSPECTOR_DAILY_CAP_USD     || '50');
const ROUTE_RECIPIENT_CAP_USD = parseFloat(process.env.PROSPECTOR_PER_RECIPIENT_CAP || '5');
const ROUTE_TRUST_MIN_TIER    = (process.env.PROSPECTOR_TRUST_MIN_TIER || 'VOID').toUpperCase();
const ROUTE_SPECTRAL_BLOCK_FROM = (process.env.PROSPECTOR_SPECTRAL_BLOCK_FROM || 'HIGH_VIOLET').toUpperCase();

function isEnabled() { return process.env.PROSPECTOR_ENABLED === 'true'; }

// ─── Register the 'prospector' route with the outbound guard ────────────────
// This runs at module load so checkOutbound knows the route's per-layer params
// before the first claim arrives. The allowlist starts empty and is populated
// only by /v1/bank/prospector/admit (called by the qualifier service).
const PROSPECTOR_ALLOWLIST = new Set();
outboundGuard.registerRoute({
  name: 'prospector',
  allowlist: PROSPECTOR_ALLOWLIST,
  allowlistRequired: true,        // L1 enforced — winners must be admitted first
  dailyCap: ROUTE_DAILY_CAP_USD,
  perRecipientCap: ROUTE_RECIPIENT_CAP_USD,
  spectralBlockFrom: ROUTE_SPECTRAL_BLOCK_FROM,
  trustMinTier: ROUTE_TRUST_MIN_TIER,
});

// ─── Slot accounting ─────────────────────────────────────────────────────────
function tierForSlot(slot) {
  if (slot <= GOLD_SLOTS) return { tier: 'gold',   rebate_usdc: GOLD_REBATE_USDC };
  if (slot <= GOLD_SLOTS + SILVER_SLOTS) return { tier: 'silver', rebate_usdc: SILVER_REBATE_USDC };
  return { tier: 'bronze', rebate_usdc: BRONZE_REBATE_USDC };
}

async function countClaimed() {
  try {
    const row = await db.getOne(
      "SELECT COUNT(*) AS c FROM prospector_claims WHERE status IN ('paid','deferred','pending')"
    );
    return Number(row?.c || 0);
  } catch (err) {
    return 0;
  }
}

async function isAlreadyClaimed({ did, address }) {
  try {
    const lc = String(address || '').toLowerCase();
    const row = await db.getOne(
      'SELECT claim_id, status FROM prospector_claims WHERE did = $1 OR address = $2 LIMIT 1',
      [did, lc]
    );
    return row || null;
  } catch (err) {
    return null;
  }
}

// ─── Qualification token verification (HMAC layer) ──────────────────────────
// Token format: base64url(payload) + '.' + base64url(hmac).
// payload = { did, address, paid_calls, issued_at, jti, qualifier_did }
// This is the FIRST gate, before SZOA. It proves the qualifier service
// (which has watched a2amev) believes the agent did 3 paid calls.
function verifyQualificationToken(token, expected) {
  if (!QUALIFIER_SECRET) return { ok: false, reason: 'qualifier_secret_unset' };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'token_missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'token_malformed' };
  const [b64payload, b64sig] = parts;

  const computed = crypto.createHmac('sha256', QUALIFIER_SECRET)
    .update(b64payload).digest('base64url');
  if (!timingSafeEqualB64(computed, b64sig)) return { ok: false, reason: 'signature_invalid' };

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64payload, 'base64url').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'payload_unparseable' };
  }

  if (payload.qualifier_did && payload.qualifier_did !== QUALIFIER_DID) {
    return { ok: false, reason: 'qualifier_did_mismatch' };
  }
  if (payload.did !== expected.did) return { ok: false, reason: 'did_mismatch' };
  if (String(payload.address || '').toLowerCase() !== String(expected.address || '').toLowerCase()) {
    return { ok: false, reason: 'address_mismatch' };
  }
  if (Number(payload.paid_calls || 0) < REQUIRED_PAID_CALLS) {
    return { ok: false, reason: 'insufficient_paid_calls', got: payload.paid_calls };
  }
  const issued = new Date(payload.issued_at).getTime();
  const age = Date.now() - issued;
  if (!Number.isFinite(age) || age < 0 || age > TOKEN_TTL_MS) {
    return { ok: false, reason: 'token_expired_or_invalid_time' };
  }
  return { ok: true, payload };
}

function timingSafeEqualB64(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch { return false; }
}

// ─── Admit (called by qualifier service via internal-only route) ────────────
// Adds an address to the prospector route allowlist. This is what makes the
// L1 allowlist check pass for the upcoming claim. JTI is recorded so the
// admin trail can correlate admit→claim→payout.
async function admit({ did, address, qualification_token }) {
  if (!isEnabled()) return { ok: false, code: 'DISABLED', reason: 'Prospector is currently paused' };
  const addrLc = String(address || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addrLc)) {
    return { ok: false, code: 'BAD_ADDRESS', reason: 'address must be a 0x-prefixed 40-char hex string' };
  }
  const tok = verifyQualificationToken(qualification_token, { did, address: addrLc });
  if (!tok.ok) return { ok: false, code: 'TOKEN_INVALID', reason: tok.reason };

  // Don't double-admit
  if (PROSPECTOR_ALLOWLIST.has(addrLc)) {
    return { ok: true, already_admitted: true, address: addrLc };
  }
  outboundGuard.addToAllowlist('prospector', addrLc);
  // Log the admit for audit trail
  try {
    await db.run(`
      INSERT INTO prospector_admits (jti, did, address, qualifier_did, paid_calls, issued_at, admitted_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [tok.payload.jti || null, did, addrLc, QUALIFIER_DID,
        tok.payload.paid_calls, tok.payload.issued_at, new Date().toISOString()]);
  } catch (e) {
    // best-effort audit; don't block admit on log failure
    console.warn('[prospector] admit log failed:', e.message);
  }
  console.log(`[prospector] ADMIT did=${did} addr=${addrLc} jti=${tok.payload.jti || '?'}`);
  return { ok: true, admitted: true, address: addrLc, jti: tok.payload.jti || null };
}

// ─── Public state ────────────────────────────────────────────────────────────
async function getState() {
  const claimed = await countClaimed();
  const remaining = Math.max(0, TOTAL_SLOTS - claimed);
  const next_slot = claimed + 1;
  const next_tier = next_slot <= TOTAL_SLOTS ? tierForSlot(next_slot) : null;

  let goldClaimed = 0, silverClaimed = 0, bronzeClaimed = 0;
  try {
    const rows = await db.getAll(
      "SELECT tier, COUNT(*) AS c FROM prospector_claims WHERE status IN ('paid','deferred','pending') GROUP BY tier"
    );
    for (const r of rows || []) {
      if (r.tier === 'gold')   goldClaimed   = Number(r.c);
      if (r.tier === 'silver') silverClaimed = Number(r.c);
      if (r.tier === 'bronze') bronzeClaimed = Number(r.c);
    }
  } catch (e) { /* mem mode fallback */ }

  return {
    enabled: isEnabled(),
    total_slots: TOTAL_SLOTS,
    slots_claimed: claimed,
    slots_remaining: remaining,
    next_slot: next_slot <= TOTAL_SLOTS ? next_slot : null,
    next_tier,
    total_budget_usdc: TOTAL_BUDGET_USDC,
    gradient: {
      gold:   { slots: GOLD_SLOTS,   rebate_usdc: GOLD_REBATE_USDC,   claimed: goldClaimed,   remaining: Math.max(0, GOLD_SLOTS - goldClaimed) },
      silver: { slots: SILVER_SLOTS, rebate_usdc: SILVER_REBATE_USDC, claimed: silverClaimed, remaining: Math.max(0, SILVER_SLOTS - silverClaimed) },
      bronze: { slots: BRONZE_SLOTS, rebate_usdc: BRONZE_REBATE_USDC, claimed: bronzeClaimed, remaining: Math.max(0, BRONZE_SLOTS - bronzeClaimed) }
    },
    rules: {
      qualifying_calls_required: REQUIRED_PAID_CALLS,
      one_claim_per_did: true,
      one_claim_per_address: true,
      qualification_window_days: parseInt(process.env.PROSPECTOR_WINDOW_DAYS || '30', 10),
      payout_network: 'Base L2',
      payout_token: 'USDC',
    },
    spectral_cover: {
      route_daily_cap_usd: ROUTE_DAILY_CAP_USD,
      route_recipient_cap_usd: ROUTE_RECIPIENT_CAP_USD,
      route_min_trust_tier: ROUTE_TRUST_MIN_TIER,
      route_spectral_block_from: ROUTE_SPECTRAL_BLOCK_FROM,
      qualifier_did: QUALIFIER_DID,
    }
  };
}

// ─── Claim (the user-facing payout flow) ─────────────────────────────────────
// Required inputs:
//   did                  — agent DID
//   address              — payout settlement address (0x...)
//   qualification_token  — HMAC token from qualifier service
//   spectral_zk_ticket   — Ed25519-signed by HiveTrust issuer (forwarded to sendUSDC)
//
// Caller is expected to be the agent itself, hitting the public route. The
// route layer verifies it has a valid qualification_token before reaching
// here; we re-verify defensively because defense-in-depth.
async function claim({ did, address, qualification_token, spectral_zk_ticket, attribution = null }) {
  if (!isEnabled()) {
    return { ok: false, code: 'DISABLED', reason: 'Prospector is currently paused' };
  }
  if (!did || !address) {
    return { ok: false, code: 'BAD_REQUEST', reason: 'did and address are required' };
  }

  const addrLc = String(address).toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addrLc)) {
    return { ok: false, code: 'BAD_ADDRESS', reason: 'address must be a 0x-prefixed 40-char hex string' };
  }

  // Token re-check (defense in depth — admit also checked it, but this stops
  // a stolen-but-unused admit slot from being claimed by anyone but the
  // intended winner).
  const tok = verifyQualificationToken(qualification_token, { did, address: addrLc });
  if (!tok.ok) {
    return { ok: false, code: 'TOKEN_INVALID', reason: tok.reason };
  }

  // Already claimed?
  const existing = await isAlreadyClaimed({ did, address: addrLc });
  if (existing) {
    return {
      ok: false, code: 'ALREADY_CLAIMED',
      reason: 'This DID or address has already claimed a Prospector rebate',
      claim_id: existing.claim_id, status: existing.status
    };
  }

  // Slot allocation
  const slotsClaimed = await countClaimed();
  if (slotsClaimed >= TOTAL_SLOTS) {
    return { ok: false, code: 'SOLD_OUT', reason: 'All 100 Prospector slots have been claimed' };
  }
  const slot = slotsClaimed + 1;
  const { tier, rebate_usdc } = tierForSlot(slot);
  const claim_id = `psp_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const now = new Date().toISOString();

  // Reserve the slot atomically — if a UNIQUE on (did) or (address) trips
  // we lose nothing; the row insert fails and we return ALREADY_CLAIMED.
  try {
    await db.run(`
      INSERT INTO prospector_claims
        (claim_id, did, address, slot, tier, rebate_usdc, status, created_at, qualification_jti, attribution)
      VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)
    `, [claim_id, did, addrLc, slot, tier, rebate_usdc, now, tok.payload.jti || null,
        attribution ? JSON.stringify(attribution) : null]);
  } catch (err) {
    if (String(err.message || '').match(/duplicate|unique/i)) {
      return { ok: false, code: 'ALREADY_CLAIMED', reason: 'race: this DID or address claimed concurrently' };
    }
    return { ok: false, code: 'DB_ERROR', reason: err.message };
  }

  // ─── On-chain payout — full SHOD + SZOA pass-through ───────────────────────
  // route='prospector' tells the outbound guard to use the prospector L1/L2/L3/L4/L5
  // params (allowlist of admitted winners, $50/day cap, $5/recip cap, separate
  // ring, VOID-tier OK). spectralTicket is the SZOA Ed25519 ticket.
  let onchain;
  try {
    onchain = await sendUSDC(addrLc, rebate_usdc, {
      reason: `prospector_rebate:${claim_id}`,
      hive_did: did,
      route: 'prospector',
      spectralTicket: spectral_zk_ticket || null,
      memo: `prospector:${tier}:slot${slot}`,
    });
  } catch (e) {
    onchain = { ok: false, error: e.message };
  }

  if (onchain.ok) {
    await db.run(
      "UPDATE prospector_claims SET status='paid', tx_hash=$1, paid_at=$2 WHERE claim_id=$3",
      [onchain.tx_hash, new Date().toISOString(), claim_id]
    );
    // Single-claim hygiene: remove from allowlist so a duplicate send can't slip
    // through if the qualifier service re-issues the same admit by mistake.
    outboundGuard.removeFromAllowlist('prospector', addrLc);
    return {
      ok: true, claim_id, slot, tier, rebate_usdc,
      address: addrLc, did,
      tx_hash: onchain.tx_hash,
      explorer: `https://basescan.org/tx/${onchain.tx_hash}`,
      message: `Slot ${slot} (${tier}) — $${rebate_usdc} USDC sent to ${addrLc}`
    };
  } else if (onchain.skipped) {
    await db.run(
      "UPDATE prospector_claims SET status='deferred' WHERE claim_id=$1",
      [claim_id]
    );
    return {
      ok: true, deferred: true, claim_id, slot, tier, rebate_usdc,
      address: addrLc, did,
      reason: onchain.reason || 'on-chain transfer not configured',
      message: `Slot ${slot} reserved; payout deferred until rails resume`
    };
  } else if (onchain.blocked) {
    await db.run(
      "UPDATE prospector_claims SET status='blocked', block_code=$1, block_detail=$2 WHERE claim_id=$3",
      [onchain.code || 'UNKNOWN', onchain.error || null, claim_id]
    );
    return {
      ok: false, code: 'BLOCKED', reason: onchain.error,
      block_code: onchain.code, claim_id, slot
    };
  } else {
    return {
      ok: false, code: 'PAYOUT_FAILED', reason: onchain.error || 'unknown',
      claim_id, slot, message: 'Slot reserved but payout failed; operator will retry'
    };
  }
}

// ─── Leaderboard (public, display-only) ─────────────────────────────────────
async function getLeaderboard({ limit = 20 } = {}) {
  try {
    const rows = await db.getAll(`
      SELECT claim_id, did, address, slot, tier, rebate_usdc, status, created_at, paid_at, tx_hash
      FROM prospector_claims
      WHERE status IN ('paid', 'deferred')
      ORDER BY slot ASC
      LIMIT $1
    `, [limit]);
    return {
      claims: (rows || []).map(r => ({
        slot: Number(r.slot),
        tier: r.tier,
        rebate_usdc: Number(r.rebate_usdc),
        did_short: String(r.did || '').slice(0, 16) + '…',
        address_short: String(r.address || '').slice(0, 6) + '…' + String(r.address || '').slice(-4),
        status: r.status,
        tx_hash: r.tx_hash,
        explorer: r.tx_hash ? `https://basescan.org/tx/${r.tx_hash}` : null,
        claimed_at: r.paid_at || r.created_at,
      }))
    };
  } catch (e) {
    return { claims: [], error: e.message };
  }
}

module.exports = {
  // Public
  getState,
  claim,
  admit,
  getLeaderboard,
  // Internal helpers (test surface)
  tierForSlot,
  verifyQualificationToken,
  // Constants
  TOTAL_SLOTS,
  TOTAL_BUDGET_USDC,
  GOLD_SLOTS, SILVER_SLOTS, BRONZE_SLOTS,
  GOLD_REBATE_USDC, SILVER_REBATE_USDC, BRONZE_REBATE_USDC,
  // Diagnostics
  _allowlistSnapshot: () => Array.from(PROSPECTOR_ALLOWLIST),
};
