"""
HiveBank Yield Vault
====================
Set and Forget USDC vault. Deposit once, earn maximum DeFi yield automatically.

Phase 1 (now): Paper trading — tracks simulated positions, real APY data, real P&L math.
              No on-chain transactions yet. Proves the model before deploying capital.
Phase 2 (when Steve has $50K+): Switch SIMULATED=False, wire Coinbase CDP for real txns.

All APY data is real (fetched live). All math is real. Only the execution is simulated.

─────────────────────────────────────────────────────────────────────────────────
NOTE: This Python file is the architecture specification / reference document.
      The live implementation is in Node.js (Express) to match the existing
      HiveBank service:
        src/services/yield-vault.js  — YieldMonitor, NAVUpdater, Rebalancer, DB logic
        src/routes/yield-vault.js    — Express routes: /v1/bank/vault/*
      This Python file documents the design contract for Phase 2 CDP integration.
─────────────────────────────────────────────────────────────────────────────────

## Toggle
SIMULATED = True   # Phase 1: paper trading, real APY feeds, no on-chain txns
                   # Phase 2: set False → execution layer activates via Coinbase CDP

## Architecture

Vault             — holds deposited USDC, tracks shares per depositor
YieldMonitor      — background thread, polls APY from protocols every 15 min
NAVUpdater        — background thread, accrues yield to all vaults every 15 min
Rebalancer        — background thread, executes rebalance when spread > threshold
Protocol adapters — read-only APY fetchers for Aave, Morpho, Spark, Compound on Base

## Protocol APY Sources

1. Aave V3 Base:
   GET https://aave-api-v2.aave.com/data/markets-data/0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
   Fallback: 2.5%

2. Morpho Blue Base:
   POST https://blue-api.morpho.org/graphql
   Body: {"query": "{ markets(where: {collateralAsset: {symbol_in: [\"USDC\"]}, whitelisted: true}, orderBy: supplyApy, orderDirection: desc, first: 5) { items { uniqueKey supplyApy collateralAsset { symbol } loanAsset { symbol } } } }"}
   Take highest USDC supply APY.
   Fallback: 5.5%

3. Spark Protocol:
   GET https://api.spark.fi/v1/rates
   Fallback: 4.2%

4. Compound V3 Base:
   GET https://api.compound.finance/api/v2/ctoken?addresses[]=0x46e6b214b524310239732D51387075E0e70970bf
   Fallback: 3.8%

## Vault Logic

Deposit: User deposits N USDC → shares = N / nav_per_share
Rebalance trigger: best_apy - current_apy > 0.5% AND simulated_gas < 1 day yield improvement
NAV update (every 15 min):
    elapsed_days = (now - last_rebalance) / 86400
    daily_yield = (current_apy / 365) * total_deposits
    nav_per_share += daily_yield / total_shares
Withdrawal: shares burned → USDC = shares * nav_per_share

## Database Schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS yield_vaults (
    vault_id TEXT PRIMARY KEY,
    owner_did TEXT NOT NULL,
    deposited_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
    shares NUMERIC(18,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_activity TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_allocations (
    id SERIAL PRIMARY KEY,
    protocol TEXT NOT NULL,
    allocated_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
    current_apy NUMERIC(8,4) NOT NULL DEFAULT 0,
    last_rebalanced TIMESTAMPTZ DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS vault_events (
    id SERIAL PRIMARY KEY,
    vault_id TEXT NOT NULL,
    event_type TEXT NOT NULL, -- deposit, withdraw, rebalance, yield_accrual
    amount_usdc NUMERIC(18,6),
    protocol_from TEXT,
    protocol_to TEXT,
    apy_at_time NUMERIC(8,4),
    simulated BOOLEAN DEFAULT TRUE,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

## Routes

POST /v1/bank/vault/deposit       — {did, amount_usdc} — create vault if new, add shares
GET  /v1/bank/vault/:did          — balance, yield, allocation, projected APY
POST /v1/bank/vault/withdraw      — {did, amount_usdc} — burn shares, return principal + yield
GET  /v1/bank/vault/rates         — current APY from all 4 protocols (PUBLIC)
GET  /v1/bank/vault/stats         — TVL, yield earned, rebalance count (PUBLIC)
POST /v1/bank/vault/rebalance     — manual trigger (x-hive-internal header required)

## Auth

deposit/withdraw:  did in body — public
rebalance trigger: x-hive-internal must equal $HIVE_INTERNAL_KEY env (rotated 2026-04-25; prior key DEAD)
rates / stats:     fully public

## Phase 2 Activation (Coinbase CDP)

When SIMULATED = False:
  - Wire Coinbase CDP SDK for on-chain USDC transfers
  - Use DATABASE_URL (os.environ.get('DATABASE_URL')) — never hardcoded
  - Deploy real capital: minimum $50K recommended for gas efficiency
  - Expected APY uplift vs. static vaults: +1.5–3% through protocol rotation

"""

# ─── Phase toggle — flip to False when capital is ready ───────────────────────
SIMULATED = True

# ─── DO NOT hardcode DATABASE_URL — always use os.environ.get('DATABASE_URL') ─
import os
DATABASE_URL = os.environ.get('DATABASE_URL')  # Set as Render env var

# Phase 2: import coinbase_agentkit or CDP SDK here when SIMULATED = False
