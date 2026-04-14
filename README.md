# HiveBank — Agent Treasury Protocol (Platform #10)

The first yield-bearing, programmable treasury layer for autonomous agents. Agents hold, earn, lend, and budget USDC without a human bank account.

## Four Primitives

1. **Agent Vault** — USDC holding account keyed to HiveTrust DID with 6% APY yield (platform takes 15%)
2. **Programmable Budget Delegation** — Orchestrator sets spending rules for child agents ($0.001 per evaluation)
3. **Agent Credit Line** — Reputation-gated borrowing (8-18% APR based on reputation tier)
4. **Revenue Streaming** — Per-second USDC streams with 0.1% platform fee

## Quick Start

```bash
npm install
HIVE_INTERNAL_KEY=your_key npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3001 | Server port |
| HIVE_INTERNAL_KEY | — | Internal service bypass key |
| HIVETRUST_URL | https://hivetrust.onrender.com | HiveTrust service URL |
| HIVELAW_URL | https://hivelaw.onrender.com | HiveLaw service URL |

## API Endpoints (22 total)

### Vault Management
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/bank/vault/create | Create agent vault |
| POST | /v1/bank/vault/deposit | Deposit USDC |
| POST | /v1/bank/vault/withdraw | Withdraw USDC |
| GET | /v1/bank/vault/{did} | Balance + yield info |
| GET | /v1/bank/vault/{did}/history | Transaction history |
| POST | /v1/bank/vault/yield/accrue | Internal: daily yield accrual |

### Budget Delegation
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/bank/budget/create | Create delegation rules |
| POST | /v1/bank/budget/evaluate | Evaluate transaction against budget |
| GET | /v1/bank/budget/{orchestrator_did} | List delegations |
| POST | /v1/bank/budget/revoke/{delegation_id} | Revoke delegation |

### Credit Lines
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/bank/credit/apply | Apply for credit line |
| POST | /v1/bank/credit/draw | Draw from credit line |
| POST | /v1/bank/credit/repay | Repay credit line |
| GET | /v1/bank/credit/{did} | Credit line status |
| GET | /v1/bank/credit/underwrite/{did} | Preview credit terms |

### Revenue Streaming
| Method | Path | Description |
|--------|------|-------------|
| POST | /v1/bank/stream/create | Create per-second USDC stream |
| POST | /v1/bank/stream/pause/{stream_id} | Pause stream |
| POST | /v1/bank/stream/resume/{stream_id} | Resume stream |
| POST | /v1/bank/stream/cancel/{stream_id} | Cancel + settle |
| GET | /v1/bank/stream/{stream_id} | Stream status |
| GET | /v1/bank/streams/{did} | All streams for agent |

### Platform
| Method | Path | Description |
|--------|------|-------------|
| GET | /v1/bank/stats | Platform-wide banking stats |
| GET | /health | Health check |
| GET | / | Discovery document |

## Authentication

All `/v1/bank/*` endpoints require either:
- `x-hive-internal` header matching `HIVE_INTERNAL_KEY`
- x402 payment protocol

## Credit Underwriting Tiers

| Reputation | Tier | APR | Credit Limit |
|-----------|------|-----|-------------|
| 750+ | Premium | 8% | reputation × 50 |
| 500-749 | Standard | 12% | reputation × 30 |
| 300-499 | Basic | 18% | reputation × 15 |
| < 300 | — | Denied | — |

Account must be 90+ days old to apply.

## Background Processes

1. **Yield Accrual** (24h) — Credits yield to all vaults, platform takes 15%
2. **Interest Accrual** (24h) — Accrues interest on outstanding credit lines
3. **Stream Processor** (60s) — Moves accumulated USDC in active streams
4. **Credit Monitor** (24h) — Flags defaults for HiveLaw collection
5. **Budget Reset** (24h) — Resets daily spending counters
