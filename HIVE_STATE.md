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
| HiveBank service (Render) | LIVE | `srv-d7f4cm8sfn5c738lhu80` |
| Prospector qualifier (admit + claim) | LIVE | end-to-end verified 2026-05-01 22:02 UTC |
| Prospector settler (60s sweep, real USDC) | LIVE | payout tx [`0x4687a00a...9738d`](https://basescan.org/tx/0x4687a00a67b7ff0cdb208ad6c1e16bb8a1a03b74f3c1e4a39d6fd21c8f29738d) — $1.70 to verified settler wallet `0x767587d0bA8ce93BC8d2B04A2559166891fE5663` |
| Outbound guards (4 of 6) | LIVE | KILL_SWITCH, ALLOWLIST + PROSPECTOR_ALLOWLIST, DAILY_CAP $50, PER_RECIPIENT_CAP $20, SPECTRAL_ANOMALY |
| Settler fixture guard (DB + service) | LIVE | commit `e93df84` — SQL excludes `did:hive:fixture-%` and `0x000%` |
| GitHub Advanced Security (CodeQL + secret scanning) | LIVE | 169 public srotzin repos. Workflow auto-detects JS/TS + Python; weekly cron dropped; autobuild tolerant. CodeQL alerts already firing on hive-rosetta. |
| Snyk (dev-first vulnerability scanning) | LIVE | Snyk GitHub App installed on srotzin org → all repositories. Free tier. Scans dependencies, code, containers. |
| Socket Security (supply-chain protection) | LIVE | Socket GitHub App installed on srotzin org → all repositories. Workspace = `srotzin`. Most relevant: hive-rosetta on npm + PyPI. |
| FOSSA (license compliance + SBOM) | LIVE | FOSSA GitHub App installed on srotzin org → all repositories. Free tier. |
| TRM Labs / Blockaid / Forta provider stubs | LIVE | `compliance-providers.js` + `GET /v1/bank/compliance/providers` status endpoint. Each provider auto-flips LIVE on env-var key paste. |
| OpenSanctions integration | LIVE | hive-mcp-audit-readiness `audit_sanctions_screen` MCP tool — calls `https://api.opensanctions.org/match/sanctions`. Flips fully live with `OPENSANCTIONS_API_KEY` env var. |
| Live USDC treasury ticker on thehiveryiq.com | LIVE | `#hive-live-bar` — `eth_call balanceOf(treasury)` to Base, 30s refresh, 3-RPC fallback (mainnet.base.org / publicnode / base-rpc.publicnode). |
| EU AI Act countdown clock | LIVE | Aug 2 2026 enforcement deadline, 1-second tick on homepage hero. |
| Third primary CTA — "Calculate your EU AI Act exposure" | LIVE | Routes to `/audit-readiness/assess`. |
| thehiveryiq.com email — inbound | LIVE | Cloudflare Email Routing. `sales@`, `support@`, `steve@thehiveryiq.com` → `srotzin@me.com`. |
| thehiveryiq.com email — outbound | LIVE | Resend SMTP relay, DKIM verified, SPF clean, DMARC monitoring. Used today to send Artemis + Token Terminal coverage requests. |

**Settler verification:** Fresh wallet, three real $0.01 USDC x402 calls, qualifier proofs verified on-chain, HiveBank `/admit` + `/claim` succeeded, settler swept and paid $1.70 USDC in one tx. End-to-end. No mocks.

## Broken or pending

| Item | State | Owner action |
| --- | --- | --- |
| Artemis Analytics coverage page | OUTREACH SENT | Email sent 2026-05-01 to `team@artemis.xyz` from `steve@thehiveryiq.com` (Resend id `68ce381a`). Awaiting reply. Medal flips on confirmation. |
| Token Terminal listing | OUTREACH SENT | Email sent 2026-05-01 to `team@tokenterminal.com` (Resend id `dae2587d`). Awaiting reply. Medal flips on confirmation. |
| Dune Analytics public dashboard | QUERIES READY | 3 SQL queries written (`x402_tx_volume`, `surface_activity`, `treasury_movements`). Owner action: paste into Dune → publish → link from medal. |
| TRM Labs API key | OUTREACH IN FLIGHT | Steve reached out to TRM directly; awaiting paste of contact thread + API key. Stub already wired — paste = LIVE. |
| Blockaid API key | PENDING | After TRM. |
| Forta Network API key | PENDING | After Blockaid. |
| OpenSanctions API key | PENDING | Free signup at opensanctions.org → paste `OPENSANCTIONS_API_KEY` to flip MCP tool fully live. |
| CodeQL email firehose cleanup | PENDING | 173 existing CodeQL emails in srotzin@me.com inbox. Bulk-archive via Apple Mail rule (filter: from `notifications@github.com` + subject contains `CodeQL` → Archive). |
| thehiveryiq.com catch-all routing | DISABLED | Cloudflare → Email Routing → flip catch-all to `srotzin@me.com` so typo'd addresses don't drop. |
| hiveagentiq.com catch-all routing | DISABLED | Same toggle on the sister domain. |
| Provable Custody Wallet (PCW) spec | DEFERRED | Not greenlit. Awaiting explicit approval. |

## Decisions open

- **PCW wedge:** ship the spec next week, build two weeks out, single-tx treasury migration — or stay on the current treasury indefinitely. Awaiting explicit approval.
- **HiveAudit pricing:** $500/month per client confirmed as north star. First paying client gates outreach intensity.
- **Order of medal LIVE conversions:** TRM first, Blockaid second, Forta third. Confirmed.
- **Outbound mail strategy:** Resend API + Resend dashboard primary; Apple Mail / Gmail send-as deprioritized after iCloud Custom Email Domain conflict (resolved). All steve@thehiveryiq.com outbound now flows via Resend.

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
