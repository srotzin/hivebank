# Hivebank Hardening — Spectral ZK Outbound Auth + 6-Layer SHOD

> Branch: `harden/spectral-zk-outbound`
> Incident: 2026-04-25, $99.99 USDC drained from treasury via `requireInternal`-gated `/v1/bank/usdc/send` using a leaked `HIVE_INTERNAL_KEY`. Signer was hivebank itself (treasury PK in env). Attack surface review revealed `HIVE_INTERNAL_KEY` alone was sufficient to authorize any outbound. This branch eliminates that single-secret attack class.

## Threat model — what this kills

| Compromise | Pre-harden | Post-harden |
|---|---|---|
| Stolen `HIVE_INTERNAL_KEY` only | Full drain | Blocked at L1 (allowlist) and ZK (no ticket) |
| Stolen `HIVE_WALLET_PRIVATE_KEY` only | Full drain | Blocked at L1, L2, L3, ZK before signer is reached |
| Stolen both keys | Full drain | Blocked at ZK — verifier key held only on HiveTrust |
| Replay of a captured ticket | n/a | Blocked at nonce + epoch |
| Precomputed ticket farm | n/a | Blocked — `regime` is unknowable in advance |
| Compromise of hivebank host | Full drain | Verifier key is public; private key never on host |

## Architecture

```
                             ┌──────────────────────────┐
   any caller ──header──►   │  hivebank /v1/bank/...   │
   (must hold a valid       │      (requireInternal)    │
    spectral-zk-ticket)      └─────────────┬────────────┘
                                           │
                                ┌──────────▼─────────┐
                                │  sendUSDC()        │
                                │  in usdc-transfer  │
                                └──────────┬─────────┘
                                           │
                          ┌────────────────▼──────────────────┐
                          │ outbound-guard.checkOutbound()    │
                          │   L0 kill_switch                  │
                          │   L1 allowlist (35 wallets)       │
                          │   L2 daily cap ($50)              │
                          │   L3 per-recipient cap ($20/24h)  │
                          │   L4 spectral-anomaly classifier  │
                          │   L5 trust gate (DID tier ≥ MOZ)  │
                          └────────────────┬──────────────────┘
                                           │  if any deny → return 403
                                           ▼
                          ┌─────────────────────────────────┐
                          │ spectral-zk-auth.verifyTicket() │
                          │   Ed25519 sig under verifier PK │
                          │   epoch ±1 of live UTC bucket   │
                          │   regime == liveRegime(ring)    │
                          │   intent == sha256(req body)    │
                          │   nonce unseen                  │
                          │   exp ≤ 5min future             │
                          └────────────────┬────────────────┘
                                           │  if any fail → return 403
                                           ▼
                                ┌──────────────────────┐
                                │ on-chain broadcast   │
                                └──────────────────────┘
```

## New env vars

| Var | Default | What it does |
|---|---|---|
| `USDC_SENDS_PAUSED` | `false` | L0 kill switch — already exists |
| `OUTBOUND_ALLOWLIST_REQUIRED` | `true` | L1 toggle |
| `OUTBOUND_DAILY_CAP_USD` | `50` | L2 cap |
| `OUTBOUND_PER_RECIPIENT_CAP` | `20` | L3 cap |
| `OUTBOUND_SPECTRAL_BLOCK_FROM` | `HIGH_VIOLET` | L4 threshold (any worse regime blocks) |
| `OUTBOUND_TRUST_MIN_TIER` | `MOZ` | L5 minimum DID tier |
| `OUTBOUND_TRUST_TIMEOUT_MS` | `1500` | L5 HiveTrust HTTP timeout |
| `HIVETRUST_URL` | `https://hivetrust.onrender.com` | L5 lookup base |
| `SPECTRAL_VERIFIER_PK_B64U` | (unset) | **Required.** Ed25519 verifier public key, base64url. **PUBLIC** — safe to ship in env. |
| `SPECTRAL_ZK_ENFORCE` | `true` | Enforce ZK. Set `false` only during planned rollout. |
| `SPECTRAL_ZK_BYPASS` | `false` | Emergency bypass — logged loudly. |
| `SPECTRAL_EPOCH_SEC` | `300` | Spectral epoch length (5 min). Must match issuer. |
| `SPECTRAL_EPOCH_DRIFT` | `1` | Allow ±1 epoch drift. |
| `SPECTRAL_TICKET_EXP_MAX` | `300` | Max ticket lifetime in seconds. |
| `SPECTRAL_NONCE_TTL_MS` | `600000` | Nonce replay-cache TTL (10 min). |

## Ticket schema

```jsonc
// base64url(JSON of:)
{
  "v":      1,
  "iss":    "did:hive:hivetrust-issuer-001",
  "epoch":  "2026-04-25T07:55:00Z",  // 5-min UTC bucket
  "regime": "NORMAL_CYAN",            // hivebank-live spectral regime
  "intent": "<sha256(canonical(to|amount|reason|did))>",
  "nonce":  "<128-bit random b64u>",
  "exp":    "2026-04-25T08:00:00Z",
  "sig":    "<ed25519(canonical_bytes(rest))>"
}
```

Header: `x-spectral-zk-ticket: <base64url-json>`.

`intent` is computed over canonical JSON: `{ to, amount: amount.toFixed(6), reason, did }`. Lowercased addresses, fixed-precision amounts.

`canonical()` is JCS (RFC 8785, simplified) — see `src/lib/canonical.js`. Identical implementation MUST be used by issuer (HiveTrust) and verifier (hivebank) — bit-identical canonicalization is what makes the signature verifiable across services.

## Files

```
src/lib/spectral.js              ← vendored from hivechroma-v0.1
src/lib/canonical.js             ← vendored from hivechroma-v0.1
src/services/outbound-guard.js   ← 6-layer SHOD
src/services/spectral-zk-auth.js ← Spectral ZK verifier
src/services/usdc-transfer.js    ← wired
src/services/referral.js         ← ticket forwarded to convertReferral
src/routes/usdc.js               ← /welcome /send /test forward header
src/routes/rewards.js            ← /claim forwards header
src/routes/pay.js                ← /pay (exit_now) forwards header
src/routes/hivewallet.js         ← /:did/send forwards header
src/routes/referral.js           ← /convert forwards header
src/routes/admin-stats.js        ← /v1/admin/stats exposes both snapshots
test/outbound-guard.test.js      ← 6 tests
test/spectral-zk-auth.test.js    ← 7 tests
package.json                     ← + @noble/ed25519 ^2.1, @noble/hashes ^1.4
```

## Deploy runbook

1. Merge `harden/spectral-zk-outbound` to `main`.
2. **On hivebank** (Render `srv-d7f4cm8sfn5c738lhu80`): set `SPECTRAL_VERIFIER_PK_B64U` to the public key only. Leave `SPECTRAL_ZK_ENFORCE=false` for the first deploy so we can verify L0–L5 work in isolation, then flip to `true`.
3. **On hivetrust**: deploy the new `/v1/trust/spectral/issue` endpoint with `SPECTRAL_ZK_ISSUER_SK_B64U` set to the private key. Hivebank MUST NOT see this env.
4. Update `hive_rebalancer_dispatcher.py` to fetch a ticket from HiveTrust before each batch.
5. Set `SPECTRAL_ZK_ENFORCE=true` on hivebank.
6. Set `USDC_SENDS_PAUSED=false` on hivebank.
7. Rotate `HIVE_INTERNAL_KEY` across all 13 services that hold it.
8. Rotate the treasury PK (Stephen does in MetaMask, sets `HIVE_WALLET_PRIVATE_KEY` on hivebank, updates `wallets.json`).

## Key generation (Stephen, OFFLINE)

```bash
# Run on a machine that is NOT hivebank, NOT in any repo:
node -e '
  const ed = require("@noble/ed25519");
  const { sha512 } = require("@noble/hashes/sha2");
  ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
  (async () => {
    const sk = ed.utils.randomPrivateKey();
    const pk = await ed.getPublicKeyAsync(sk);
    console.log("PUBLIC  (hivebank): SPECTRAL_VERIFIER_PK_B64U=" + Buffer.from(pk).toString("base64url"));
    console.log("PRIVATE (hivetrust): SPECTRAL_ZK_ISSUER_SK_B64U=" + Buffer.from(sk).toString("base64url"));
  })();
'
```

The PRIVATE key NEVER goes on hivebank. Only on HiveTrust (`srv-...` set in Render env).

## Tests

```bash
npm install
node --test test/outbound-guard.test.js test/spectral-zk-auth.test.js
# 13 tests, 13 pass.
```

## Telemetry

`GET /v1/admin/stats` (header `x-hive-internal: $ADMIN_STATS_SECRET`) now returns:

```jsonc
{
  "ok": true,
  "outbound_guard": { "kill_switch": false, "daily": {...}, "spectral": {...}, "allowlist": {...}, "trust": {...} },
  "spectral_zk": { "enforced": true, "verifier_set": true, "current_epoch": "...", "nonce_cache": 0, ... }
}
```

The Leak Sentinel cron should add a Pass 2 check on `outbound_guard.daily.used` to alert if the daily cap is approached without operator awareness.
