# HIVE_STATE

Single source of truth for what's actually live, what's broken, what's open, and how much money the treasury holds. Updated whenever state changes — read it first before assuming anything works.

Brand: gold `#C08D23`. Voice: Bloomberg/Stripe. No superlatives. Real rails only.

---

## Live & verified

| Surface | Status | Evidence |
| --- | --- | --- |
| Treasury (Base) | LIVE | [`0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E`](https://basescan.org/address/0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E) |
| USDC settlement contract (Base) | LIVE | [`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) |
| LLM compute endpoint | LIVE | `POST https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions` |
| HiveBank service (Render) | LIVE | `srv-d7f4cm8sfn5c738lhu80`, deploy `dep-d7qi5ce7r5hc73d27ur0` |
| Prospector qualifier (admit + claim) | LIVE | end-to-end verified 2026-05-01 22:02 UTC |
| Prospector settler (60s sweep, real USDC) | LIVE | payout tx [`0x4687a00a...9738d`](https://basescan.org/tx/0x4687a00a67b7ff0cdb208ad6c1e16bb8a1a03b74f3c1e4a39d6fd21c8f29738d) — $1.70 to verified settler wallet `0x767587d0bA8ce93BC8d2B04A2559166891fE5663` |
| Outbound guards (4 of 6) | LIVE | KILL_SWITCH, ALLOWLIST + PROSPECTOR_ALLOWLIST, DAILY_CAP $50, PER_RECIPIENT_CAP $20, SPECTRAL_ANOMALY |
| Settler fixture guard (DB + service) | LIVE | commit `e93df84` — SQL excludes `did:hive:fixture-%` and `0x000%` |

**Settler verification:** Fresh wallet, three real $0.01 USDC x402 calls, qualifier proofs verified on-chain, HiveBank `/admit` + `/claim` succeeded, settler swept and paid $1.70 USDC in one tx. End-to-end. No mocks.

## Broken or pending

| Item | State | Owner action |
| --- | --- | --- |
| HIVE_STATE.md | NEW | Just initialized; will be updated on every state-change commit. |
| GitHub Advanced Security on public srotzin repos | PENDING | CodeQL workflow rollout queued (Track A step 4). |
| Snyk / Socket / FOSSA org install | PENDING | Track B install links delivered to user — one-click each. |
| Artemis Analytics / Token Terminal medals | KEY PENDING | Listing emails drafted for approval before send (Track C). |
| Dune Hive panels (3 SQL queries) | PENDING | Authoring x402 tx volume / surface activity / treasury movements queries. |
| OpenSanctions integration in readiness assessment | PENDING | Open-source library integration; badge to follow. |
| TRM Labs / Blockaid / Forta integrations | STUBBED | Behind env-var feature flags; flipping LIVE = paste API key + redeploy. |
| Live USDC ticker on thehiveryiq.com | PENDING | 30s `eth_call` `balanceOf(treasury)` to Base — Track A step 3. |
| Aug 2 2026 EU AI Act countdown clock | PENDING | Site addition. |
| Third CTA "Calculate your EU AI Act exposure" | PENDING | Routes to readiness assessment. |
| Provable Custody Wallet (PCW) spec | DEFERRED | Not greenlit. Track A first. RZK + RSHOD + Spectral attestation chain wedge if approved. |

## Decisions open

- **PCW wedge:** ship the spec next week, build two weeks out, single-tx treasury migration — or stay on the current treasury indefinitely. Awaiting explicit approval.
- **HiveAudit pricing:** $500/month per client confirmed as north star. First paying client gates outreach intensity.
- **Order of medal LIVE conversions:** TRM first, Blockaid second, Forta third. Confirmed.

## Current treasury balance

**$339.06 USDC** on Base, address [`0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E`](https://basescan.org/address/0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E), read at 2026-05-01 22:30 UTC.

Recent flow:
- $342.49 starting balance
- −$1.70 paid to verified settler wallet (real address) — tx `0x4687a00a...9738d`
- −$1.70 paid to fixture address `0x000...dead` — recovered as audit history (`payout_status='burned_fixture'`); will not re-sweep.
- −$0.06 USDC + tiny ETH gas funded out for verification; +$0.03 returned via three proof x402 calls.

Net session: **−$3.43 USDC**. Both real-rail proofs cost less than a coffee.

---

*Source: srotzin/hivebank `main`. Update with the same commit that changes the underlying state — do not let this drift.*
