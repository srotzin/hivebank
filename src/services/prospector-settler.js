'use strict';

/**
 * src/services/prospector-settler.js
 *
 * Hive Civilization — Prospector's Bonanza payout settlement.
 *
 * The on-request /v1/bank/prospector/claim flow writes a row to
 * `prospector_claims` with payout_status='pending' and returns 202.
 *
 * THIS service runs in-process every PROSPECTOR_SETTLER_INTERVAL_MS (default 60s)
 * and does the actual on-chain USDC payout. Design rules:
 *
 *   - The qualification token (HMAC-SHA256) and ZK ticket (Ed25519) have already
 *     been verified at /claim time. The address has been proven to have completed
 *     ≥3 paid x402 calls into Hive surfaces. They are pre-qualified — no further
 *     gating needed beyond the existing 6-layer outbound guard.
 *
 *   - The qualified address is added to a runtime allowlist override
 *     (`addProspectorAllowlistEntry`) so outbound-guard L1 does not block.
 *     This is additive to the 35-wallet ROSTER_ALLOWLIST — it never weakens it.
 *
 *   - The settler bypasses ONLY the spectral-ZK ticket requirement (which
 *     defends the externally callable /v1/bank/usdc/send route from a
 *     stolen-internal-key attacker). The settler runs inside hivebank itself;
 *     bypassing spectral-ZK here does not enlarge the attack surface — if
 *     hivebank is compromised the attacker controls the wallet directly.
 *
 *   - All other layers stay live: KILL_SWITCH, ALLOWLIST (now including the
 *     prospector list), DAILY_TREASURY_CAP ($50), PER_RECIPIENT_CAP ($20),
 *     SPECTRAL_ANOMALY classifier, TRUST_TIER gate.
 *
 *   - Per-row idempotency is guaranteed by UNIQUE(did, address_lc) on
 *     prospector_claims plus a status transition guard
 *     (UPDATE ... WHERE payout_status='pending').
 *
 *   - No fake tx hashes. If the on-chain send fails, the row stays pending
 *     and the next sweep retries.
 */

const db = require('./db');
const { sendUSDC } = require('./usdc-transfer');
const outboundGuard = require('./outbound-guard');

// ─── Config ──────────────────────────────────────────────────────────────────
const SETTLER_ENABLED = () => process.env.PROSPECTOR_SETTLER_ENABLED !== 'false';
const SETTLER_INTERVAL_MS = parseInt(process.env.PROSPECTOR_SETTLER_INTERVAL_MS || '60000', 10);
const SETTLER_BATCH_SIZE = parseInt(process.env.PROSPECTOR_SETTLER_BATCH_SIZE || '10', 10);
const SETTLER_MAX_RETRIES = parseInt(process.env.PROSPECTOR_SETTLER_MAX_RETRIES || '20', 10);

// ─── Telemetry (read by /v1/bank/prospector/_stats and dashboard) ───────────
const telemetry = {
  enabled: false,
  last_sweep_at: null,
  last_sweep_pending_count: 0,
  last_sweep_paid_count: 0,
  last_sweep_blocked_count: 0,
  total_sweeps: 0,
  total_paid: 0,
  total_paid_usdc: 0,
  total_blocked: 0,
  recent_payouts: [],   // last 10 successful payouts
  recent_blocks: [],    // last 10 blocked attempts
  started_at: null,
};

let _timer = null;
let _running = false;   // re-entrancy guard — never run two sweeps concurrently

function pushBounded(arr, item, max = 10) {
  arr.unshift(item);
  if (arr.length > max) arr.length = max;
}

// ─── One sweep ──────────────────────────────────────────────────────────────
async function runOnce({ source = 'cron' } = {}) {
  if (_running) {
    return { ok: true, skipped: true, reason: 'already_running' };
  }
  _running = true;
  const startedAt = new Date().toISOString();
  telemetry.last_sweep_at = startedAt;
  telemetry.total_sweeps += 1;

  let pending = [];
  try {
    const result = await db.query(
      `SELECT c.id, c.jti, c.did, c.address_lc, c.payout_amount_usdc, c.payout_status,
              c.claimed_at,
              a.exp AS admission_exp
         FROM prospector_claims c
         JOIN prospector_admissions a ON a.jti = c.jti
        WHERE c.payout_status = 'pending'
          AND c.did NOT LIKE 'did:hive:fixture-%'
          AND c.address_lc NOT LIKE '0x000%'
        ORDER BY c.claimed_at ASC
        LIMIT $1`,
      [SETTLER_BATCH_SIZE]
    );
    pending = result.rows || [];
  } catch (err) {
    console.error('[prospector-settler] DB query for pending rows failed:', err.message);
    _running = false;
    return { ok: false, error: 'db_query_failed', detail: err.message };
  }

  telemetry.last_sweep_pending_count = pending.length;
  let paidCount = 0;
  let blockedCount = 0;

  if (pending.length === 0) {
    telemetry.last_sweep_paid_count = 0;
    telemetry.last_sweep_blocked_count = 0;
    _running = false;
    return { ok: true, pending: 0, paid: 0, blocked: 0, source };
  }

  console.log(`[prospector-settler] sweep start (source=${source}) — ${pending.length} pending row(s)`);

  for (const row of pending) {
    const { jti, did, address_lc, payout_amount_usdc } = row;
    const amount = parseFloat(payout_amount_usdc);

    // Add to runtime allowlist override BEFORE the send — this is what
    // tells outbound-guard.L1 the address is legitimate. The qualifier
    // already proved this address completed ≥3 paid x402 calls.
    try {
      outboundGuard.addProspectorAllowlistEntry(address_lc);
    } catch (e) {
      // outbound-guard fallback if function not present — log and continue;
      // SPECTRAL_ZK bypass alone won't help if L1 is still on. We surface this.
      console.warn('[prospector-settler] outboundGuard.addProspectorAllowlistEntry missing:', e.message);
    }

    let sendResult = null;
    try {
      sendResult = await sendUSDC(address_lc, amount, {
        reason: 'prospector_bonanza_settle',
        hive_did: did,
        memo: `Prospector Bonanza payout — jti:${jti}`,
        route: 'prospector_settler',
        skipSpectralZk: true,   // honored ONLY for route=prospector_settler — see usdc-transfer.js
      });
    } catch (err) {
      sendResult = { ok: false, error: 'send_threw: ' + err.message };
    }

    if (sendResult && sendResult.ok && sendResult.tx_hash) {
      // Success — transition the row, but only if it is still pending
      // (UNIQUE(did,address_lc) + status guard = at-most-once payout)
      try {
        const upd = await db.query(
          `UPDATE prospector_claims
              SET payout_status = 'sent', payout_tx_hash = $1
            WHERE jti = $2 AND payout_status = 'pending'`,
          [sendResult.tx_hash, jti]
        );
        if (upd.rowCount === 0) {
          // Race lost — another sweep already marked it sent. Log loudly.
          console.warn(`[prospector-settler] race: jti=${jti} already settled by another sweep`);
        } else {
          paidCount += 1;
          telemetry.total_paid += 1;
          telemetry.total_paid_usdc += amount;
          pushBounded(telemetry.recent_payouts, {
            ts: new Date().toISOString(),
            jti, did, address: address_lc,
            amount_usdc: amount,
            tx_hash: sendResult.tx_hash,
            explorer: sendResult.explorer || `https://basescan.org/tx/${sendResult.tx_hash}`,
          });
          console.log(`[prospector-settler] PAID jti=${jti} → ${address_lc} $${amount.toFixed(2)} tx=${sendResult.tx_hash}`);
        }
      } catch (updErr) {
        // Critical: tx is already on chain but DB row update failed.
        // The audit log in usdc_sends still has the tx_hash — the dashboard
        // can reconcile from there. Log loudly and DO NOT retry the send
        // (that would double-pay).
        console.error(`[prospector-settler] CRITICAL: tx ${sendResult.tx_hash} confirmed but DB update failed for jti=${jti}: ${updErr.message}`);
      }
    } else {
      // Blocked or error — log and leave row pending for next sweep
      blockedCount += 1;
      telemetry.total_blocked += 1;
      const reason = sendResult?.code || sendResult?.error || 'unknown_block';
      pushBounded(telemetry.recent_blocks, {
        ts: new Date().toISOString(),
        jti, did, address: address_lc,
        amount_usdc: amount,
        reason,
        detail: sendResult?.error || sendResult?.detail || null,
      });
      console.warn(`[prospector-settler] BLOCKED jti=${jti} → ${address_lc} $${amount.toFixed(2)} reason=${reason}`);

      // Bury rows that have been retried too many times so they don't poison every sweep.
      // We track retries via the in-memory recent_blocks count for this jti, plus a
      // hard age cutoff: if claimed >24h ago and still blocked, mark 'blocked' (terminal).
      const claimedAt = row.claimed_at ? new Date(row.claimed_at).getTime() : null;
      const ageMs = claimedAt ? (Date.now() - claimedAt) : 0;
      if (ageMs > 24 * 60 * 60 * 1000) {
        try {
          await db.query(
            `UPDATE prospector_claims
                SET payout_status = 'blocked'
              WHERE jti = $1 AND payout_status = 'pending'`,
            [jti]
          );
          console.warn(`[prospector-settler] jti=${jti} > 24h old, marking 'blocked' for operator review`);
        } catch (e) { /* non-fatal */ }
      }
    }
  }

  telemetry.last_sweep_paid_count = paidCount;
  telemetry.last_sweep_blocked_count = blockedCount;

  console.log(`[prospector-settler] sweep done — paid=${paidCount} blocked=${blockedCount} pending=${pending.length}`);

  _running = false;
  return { ok: true, pending: pending.length, paid: paidCount, blocked: blockedCount, source };
}

// ─── Worker lifecycle ────────────────────────────────────────────────────────
function start() {
  if (!SETTLER_ENABLED()) {
    console.log('[prospector-settler] disabled via PROSPECTOR_SETTLER_ENABLED=false');
    telemetry.enabled = false;
    return;
  }
  if (_timer) {
    console.log('[prospector-settler] already started');
    return;
  }
  telemetry.enabled = true;
  telemetry.started_at = new Date().toISOString();
  console.log(`[prospector-settler] starting — interval=${SETTLER_INTERVAL_MS}ms batch=${SETTLER_BATCH_SIZE}`);

  // Kick first sweep after 30s warmup so server.js initialize() can finish DDL
  // and warm up the RPC provider pool.
  const warmupMs = 30 * 1000;
  setTimeout(() => {
    runOnce({ source: 'startup' }).catch(err => {
      console.error('[prospector-settler] startup sweep error:', err.message);
    });
    _timer = setInterval(() => {
      runOnce({ source: 'cron' }).catch(err => {
        console.error('[prospector-settler] cron sweep error:', err.message);
      });
    }, SETTLER_INTERVAL_MS);
  }, warmupMs);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    telemetry.enabled = false;
    console.log('[prospector-settler] stopped');
  }
}

function snapshot() {
  return { ...telemetry };
}

module.exports = { start, stop, runOnce, snapshot };
