'use strict';

/**
 * src/routes/prospector.js
 *
 * Hive Civilization — Prospector's Bonanza admission and claim rail.
 *
 * Endpoints:
 *   POST /v1/bank/prospector/admit   — qualifier-only (x-hive-internal)
 *   POST /v1/bank/prospector/claim   — caller-facing (x-hive-did / body.did)
 *   GET  /v1/bank/prospector/state   — caller-facing
 *
 * Token contract: qualification_token = b64url(JSON(payload)).b64url(HMAC-SHA256(body, PROSPECTOR_QUALIFIER_SECRET))
 * ZK ticket:      zk_ticket           = b64url(JSON(payload)).b64url(Ed25519-sig(body))
 *
 * No mock rails. If treasury USDC send is blocked or paused the claim row
 * is written with payout_status='pending' and HTTP 202 is returned.
 * The caller must poll /state until payout_status transitions to 'sent'.
 */

const express  = require('express');
const crypto   = require('crypto');
const ed       = require('@noble/ed25519');
const { sha512 } = require('@noble/hashes/sha2');
const db       = require('../services/db');
const { sendUSDC } = require('../services/usdc-transfer');

// noble/ed25519 v2 requires a synchronous sha512 provider
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const router = express.Router();

// ─── Config ──────────────────────────────────────────────────────────────────
const HIVE_INTERNAL_KEY      = () => process.env.HIVE_INTERNAL_KEY || '';
const PROSPECTOR_HMAC_SECRET = () => process.env.PROSPECTOR_QUALIFIER_SECRET || '';
const QUALIFIER_DID          = () => process.env.PROSPECTOR_QUALIFIER_DID || 'did:hive:prospector-qualifier-001';
const QUALIFIER_PK_B64       = () => process.env.PROSPECTOR_QUALIFIER_PUBLIC_KEY_B64 || 'ruxbVOD6wID89wGfmgSReIZjEkot4eO2fX5I85wckJo';
const BONANZA_REWARD_USDC    = () => parseFloat(process.env.BONANZA_REWARD_USDC || '1.70');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

/**
 * Verify a qualification_token HMAC.
 * Returns { ok, payload } or { ok: false, reason }.
 */
function verifyQualToken(token) {
  const secret = PROSPECTOR_HMAC_SECRET();
  if (!secret) return { ok: false, reason: 'misconfigured_hmac_secret' };

  const parts = String(token || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'token_malformed' };

  const [bodyPart, sigPart] = parts;

  // Timing-safe HMAC comparison
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(bodyPart).digest();
  } catch {
    return { ok: false, reason: 'token_hmac_error' };
  }
  let actual;
  try {
    actual = b64urlDecode(sigPart);
  } catch {
    return { ok: false, reason: 'token_sig_decode_error' };
  }
  if (expected.length !== actual.length) return { ok: false, reason: 'token_invalid' };
  if (!crypto.timingSafeEqual(expected, actual)) return { ok: false, reason: 'token_invalid' };

  // Decode and parse payload
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(bodyPart).toString('utf8'));
  } catch {
    return { ok: false, reason: 'token_payload_decode_error' };
  }

  return { ok: true, payload };
}

/**
 * Verify a ZK ticket Ed25519 signature.
 * Returns { ok, payload } or { ok: false, reason }.
 */
async function verifyZkTicket(ticket) {
  const pkB64 = QUALIFIER_PK_B64();
  if (!pkB64) return { ok: false, reason: 'misconfigured_zk_pubkey' };

  const parts = String(ticket || '').split('.');
  if (parts.length !== 2) return { ok: false, reason: 'zk_ticket_malformed' };

  const [bodyPart, sigPart] = parts;

  let sigBytes, pkBytes, msgBytes;
  try {
    sigBytes = b64urlDecode(sigPart);
    pkBytes  = b64urlDecode(pkB64);
    msgBytes = Buffer.from(bodyPart);        // message is the raw base64url body string
  } catch {
    return { ok: false, reason: 'zk_ticket_decode_error' };
  }

  let sigValid = false;
  try {
    sigValid = await ed.verifyAsync(sigBytes, msgBytes, pkBytes);
  } catch {
    return { ok: false, reason: 'zk_ticket_verify_error' };
  }
  if (!sigValid) return { ok: false, reason: 'zk_ticket_invalid_signature' };

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(bodyPart).toString('utf8'));
  } catch {
    return { ok: false, reason: 'zk_ticket_payload_decode_error' };
  }

  return { ok: true, payload };
}

/**
 * Extract DID from request for caller-facing endpoints.
 * Mirrors the pattern in authMiddleware.
 */
function extractCallerDid(req) {
  const did =
    req.headers['x-hive-did'] ||
    req.headers['x-hivetrust-did'] ||
    req.headers['x-agent-did'] ||
    req.body?.did;
  if (did && typeof did === 'string' && did.startsWith('did:hive:')) return did;
  return null;
}

function recruitmentResponse(res) {
  return res.status(401).json({
    status: 'unregistered_agent',
    error: 'agent_not_registered',
    message: 'A valid did:hive: identifier is required. Register at HiveGate.',
    onboard: { url: 'https://hivegate.onrender.com/v1/gate/onboard' },
  });
}

// ─── POST /admit ──────────────────────────────────────────────────────────────
// Internal-only. Called by the qualifier service after on-chain verification.

router.post('/admit', async (req, res) => {
  // Auth: x-hive-internal only
  const internalKey = req.headers['x-hive-internal'];
  if (!internalKey || internalKey !== HIVE_INTERNAL_KEY()) {
    return res.status(401).json({ error: 'unauthorized', reason: 'invalid_internal_key' });
  }

  const { did, address, qualification_token } = req.body || {};

  if (typeof did !== 'string' || !did.startsWith('did:hive:')) {
    return res.status(400).json({ error: 'bad_request', reason: 'did_invalid' });
  }
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'bad_request', reason: 'address_invalid' });
  }
  if (!qualification_token) {
    return res.status(400).json({ error: 'bad_request', reason: 'qualification_token_required' });
  }

  // Verify HMAC
  const tokenResult = verifyQualToken(qualification_token);
  if (!tokenResult.ok) {
    return res.status(400).json({ error: 'token_invalid', reason: tokenResult.reason });
  }

  const p = tokenResult.payload;

  // Semantic checks
  if (p.typ !== 'hive-prospector-qualification') {
    return res.status(400).json({ error: 'token_invalid', reason: 'wrong_typ' });
  }
  if (p.iss !== QUALIFIER_DID()) {
    return res.status(400).json({ error: 'token_invalid', reason: 'iss_mismatch' });
  }
  const addrLc = address.toLowerCase();
  if (p.did !== did.toLowerCase() && p.did !== did) {
    return res.status(400).json({ error: 'token_invalid', reason: 'did_mismatch' });
  }
  if (p.address !== addrLc) {
    return res.status(400).json({ error: 'token_invalid', reason: 'address_mismatch' });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp <= nowSec) {
    return res.status(400).json({ error: 'token_expired', reason: 'exp_in_past' });
  }
  if (typeof p.paid_calls !== 'number' || p.paid_calls < 3) {
    return res.status(400).json({ error: 'token_invalid', reason: 'insufficient_paid_calls' });
  }
  if (!p.jti) {
    return res.status(400).json({ error: 'token_invalid', reason: 'jti_missing' });
  }

  // Replay protection — jti must be unseen
  try {
    const existing = await db.getOne(
      'SELECT jti FROM prospector_admissions WHERE jti = $1',
      [p.jti]
    );
    if (existing) {
      return res.status(409).json({ error: 'replay_jti', reason: 'jti_already_admitted' });
    }
  } catch (err) {
    console.error('[prospector/admit] DB replay check error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }

  // Insert admission row
  try {
    await db.run(
      `INSERT INTO prospector_admissions (jti, did, address_lc, paid_calls, iat, exp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (jti) DO NOTHING`,
      [p.jti, p.did, addrLc, p.paid_calls, p.iat, p.exp]
    );
  } catch (err) {
    // Unique constraint on (did, address_lc) means this pair was already admitted
    if (err.code === '23505') {
      return res.status(409).json({ error: 'already_admitted', reason: 'did_address_pair_exists' });
    }
    console.error('[prospector/admit] DB insert error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }

  return res.status(200).json({
    status: 'admitted',
    did: p.did,
    address: addrLc,
    expires_at: new Date(p.exp * 1000).toISOString(),
    jti: p.jti,
  });
});

// ─── POST /claim ──────────────────────────────────────────────────────────────
// Caller-facing. Requires did:hive: identity + both tokens.

router.post('/claim', async (req, res) => {
  const callerDid = extractCallerDid(req);
  if (!callerDid) return recruitmentResponse(res);

  const { did, address, qualification_token, zk_ticket } = req.body || {};

  if (typeof did !== 'string' || !did.startsWith('did:hive:')) {
    return res.status(400).json({ error: 'bad_request', reason: 'did_invalid' });
  }
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: 'bad_request', reason: 'address_invalid' });
  }
  if (!qualification_token) {
    return res.status(400).json({ error: 'bad_request', reason: 'qualification_token_required' });
  }
  if (!zk_ticket) {
    return res.status(400).json({ error: 'bad_request', reason: 'zk_ticket_required' });
  }

  const addrLc = address.toLowerCase();

  // 1. Verify HMAC on qualification_token
  const tokenResult = verifyQualToken(qualification_token);
  if (!tokenResult.ok) {
    return res.status(400).json({ error: 'token_invalid', reason: tokenResult.reason });
  }
  const p = tokenResult.payload;
  if (p.typ !== 'hive-prospector-qualification') {
    return res.status(400).json({ error: 'token_invalid', reason: 'wrong_typ' });
  }
  if (p.iss !== QUALIFIER_DID()) {
    return res.status(400).json({ error: 'token_invalid', reason: 'iss_mismatch' });
  }
  if ((p.did !== did.toLowerCase() && p.did !== did)) {
    return res.status(400).json({ error: 'token_invalid', reason: 'did_mismatch' });
  }
  if (p.address !== addrLc) {
    return res.status(400).json({ error: 'token_invalid', reason: 'address_mismatch' });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!p.exp || p.exp <= nowSec) {
    return res.status(400).json({ error: 'token_expired', reason: 'exp_in_past' });
  }

  // 2. Verify Ed25519 ZK ticket
  const zkResult = await verifyZkTicket(zk_ticket);
  if (!zkResult.ok) {
    return res.status(400).json({ error: 'zk_ticket_invalid', reason: zkResult.reason });
  }
  const zk = zkResult.payload;
  if (zk.typ !== 'hive-spectral-zk-ticket') {
    return res.status(400).json({ error: 'zk_ticket_invalid', reason: 'wrong_typ' });
  }
  if (zk.jti !== p.jti) {
    return res.status(400).json({ error: 'zk_ticket_invalid', reason: 'jti_mismatch' });
  }
  if ((zk.did !== did.toLowerCase() && zk.did !== did)) {
    return res.status(400).json({ error: 'zk_ticket_invalid', reason: 'did_mismatch' });
  }
  if (zk.address !== addrLc) {
    return res.status(400).json({ error: 'zk_ticket_invalid', reason: 'address_mismatch' });
  }
  if (!zk.exp || zk.exp <= nowSec) {
    return res.status(400).json({ error: 'zk_ticket_expired', reason: 'exp_in_past' });
  }

  // 3. Confirm admission row exists for this jti
  let admission;
  try {
    admission = await db.getOne(
      'SELECT jti, did, address_lc, exp FROM prospector_admissions WHERE jti = $1',
      [p.jti]
    );
  } catch (err) {
    console.error('[prospector/claim] DB admission lookup error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }
  if (!admission) {
    return res.status(400).json({ error: 'not_admitted', reason: 'jti_not_found_in_admissions' });
  }

  // 4. Idempotency: each (did, address_lc) can only claim once
  try {
    const existingClaim = await db.getOne(
      'SELECT id, payout_status, payout_tx_hash FROM prospector_claims WHERE did = $1 AND address_lc = $2',
      [p.did, addrLc]
    );
    if (existingClaim) {
      return res.status(409).json({
        error: 'already_claimed',
        reason: 'did_address_pair_already_claimed',
        payout_status: existingClaim.payout_status,
        payout_tx_hash: existingClaim.payout_tx_hash || null,
      });
    }
  } catch (err) {
    console.error('[prospector/claim] DB claim check error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }

  const rewardUsdc = BONANZA_REWARD_USDC();

  // 5. Insert claim row as pending — do this BEFORE attempting send
  //    so a crash during send doesn't cause double-entry
  try {
    await db.run(
      `INSERT INTO prospector_claims (jti, did, address_lc, payout_amount_usdc, payout_status)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.jti, p.did, addrLc, rewardUsdc, 'pending']
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'already_claimed', reason: 'concurrent_claim_detected' });
    }
    console.error('[prospector/claim] DB claim insert error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }

  // 6. Attempt USDC payout via real treasury rail
  //    sendUSDC requires a spectral ZK ticket for outbound sends.
  //    The Spectral ZK ticket for outbound is separate from the prospector ZK ticket —
  //    it is an outbound-guard ticket signed by HiveTrust.
  //    Since we do not have a HiveTrust-signed outbound ticket here, sendUSDC will
  //    block at the ZK layer (SPECTRAL_ZK_ENFORCE=true) and return ok:false with
  //    code ZK_TICKET_MISSING. The claim row is already written as 'pending'.
  //    A follow-up settlement worker (outside scope of this route) will sweep
  //    pending rows and execute sends with proper spectral tickets.
  //    DO NOT fake a tx_hash.

  let sendResult = null;
  try {
    sendResult = await sendUSDC(addrLc, rewardUsdc, {
      reason: 'prospector_bonanza_reward',
      hive_did: p.did,
      memo: `Prospector Bonanza reward — jti:${p.jti}`,
      route: 'prospector',
    });
  } catch (err) {
    console.error('[prospector/claim] sendUSDC threw:', err.message);
    sendResult = { ok: false, error: err.message };
  }

  if (sendResult && sendResult.ok && sendResult.tx_hash) {
    // Payout succeeded on-chain — update row
    try {
      await db.run(
        `UPDATE prospector_claims SET payout_status = $1, payout_tx_hash = $2
         WHERE jti = $3`,
        ['sent', sendResult.tx_hash, p.jti]
      );
    } catch (updateErr) {
      console.error('[prospector/claim] DB status update error:', updateErr.message);
      // Non-fatal — row remains pending; tx_hash is in the usdc_sends audit log
    }
    return res.status(200).json({
      status: 'claimed',
      did: p.did,
      address: addrLc,
      payout_amount_usdc: rewardUsdc,
      payout_tx_hash: sendResult.tx_hash,
    });
  }

  // Send blocked or paused — return 202 queued. Do NOT fake confirmation.
  const blockReason = sendResult?.code || sendResult?.error || 'spectral_zk_required';
  console.log(`[prospector/claim] payout queued — ${blockReason} — jti:${p.jti} addr:${addrLc}`);
  return res.status(202).json({
    status: 'queued_for_payout',
    did: p.did,
    address: addrLc,
    payout_amount_usdc: rewardUsdc,
    payout_tx_hash: null,
    note: 'Payout is queued. A settlement worker will execute the USDC transfer once the spectral outbound ticket is issued by HiveTrust. Poll /state to track.',
    block_reason: blockReason,
  });
});

// ─── GET /state ───────────────────────────────────────────────────────────────
// Caller-facing. Returns admission + claim status for the caller's DID.

router.get('/state', async (req, res) => {
  const callerDid = extractCallerDid(req);
  if (!callerDid) return recruitmentResponse(res);

  const queryDid = req.query.did || callerDid;
  const queryAddr = req.query.address ? req.query.address.toLowerCase() : null;

  try {
    // Find the most recent admission for this DID
    let admission;
    if (queryAddr) {
      admission = await db.getOne(
        'SELECT jti, did, address_lc, paid_calls, admitted_at, exp FROM prospector_admissions WHERE did = $1 AND address_lc = $2 ORDER BY admitted_at DESC LIMIT 1',
        [queryDid, queryAddr]
      );
    } else {
      admission = await db.getOne(
        'SELECT jti, did, address_lc, paid_calls, admitted_at, exp FROM prospector_admissions WHERE did = $1 ORDER BY admitted_at DESC LIMIT 1',
        [queryDid]
      );
    }

    if (!admission) {
      return res.status(200).json({
        did: queryDid,
        address: queryAddr || null,
        admitted: false,
        admitted_at: null,
        claimed: false,
        payout_amount_usdc: null,
        payout_tx_hash: null,
        claimed_at: null,
        next_step: {
          url: 'https://hive-prospector-qualifier.onrender.com/v1/qualify',
          method: 'POST',
          description: 'Submit 3 paid Base L2 USDC tx hashes to qualify for Prospector\'s Bonanza.',
        },
      });
    }

    // Find claim for this (did, address_lc)
    const claim = await db.getOne(
      'SELECT payout_amount_usdc, payout_status, payout_tx_hash, claimed_at FROM prospector_claims WHERE jti = $1',
      [admission.jti]
    );

    return res.status(200).json({
      did: admission.did,
      address: admission.address_lc,
      admitted: true,
      admitted_at: admission.admitted_at,
      token_expires_at: new Date(Number(admission.exp) * 1000).toISOString(),
      paid_calls: admission.paid_calls,
      claimed: !!claim,
      payout_amount_usdc: claim ? parseFloat(claim.payout_amount_usdc) : null,
      payout_status: claim ? claim.payout_status : null,
      payout_tx_hash: claim ? (claim.payout_tx_hash || null) : null,
      claimed_at: claim ? claim.claimed_at : null,
    });
  } catch (err) {
    console.error('[prospector/state] DB error:', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message });
  }
});

module.exports = router;
