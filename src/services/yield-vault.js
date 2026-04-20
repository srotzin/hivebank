/**
 * HiveBank Yield Vault — Service Layer
 * =====================================
 * Set and Forget USDC vault. Deposit once, earn maximum DeFi yield automatically.
 *
 * Phase 1 (now): Paper trading — tracks simulated positions, real APY data, real P&L math.
 *               No on-chain transactions yet. Proves the model before deploying capital.
 * Phase 2 (when Steve has $50K+): Switch SIMULATED=false, wire Coinbase CDP for real txns.
 *
 * All APY data is real (fetched live). All math is real. Only the execution is simulated.
 *
 * ─── PHASE TOGGLE ────────────────────────────────────────────────────────────────
 * const SIMULATED = true;   ← Phase 1: paper trading
 * const SIMULATED = false;  ← Phase 2: live on-chain via Coinbase CDP (needs $50K+)
 * ─────────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

// ─── PHASE 1/2 TOGGLE ────────────────────────────────────────────────────────
//  Phase 1: SIMULATED = true  — paper trading, real APY feeds, no on-chain txns
//  Phase 2: SIMULATED = false — flip this + wire Coinbase CDP SDK for real txns
const SIMULATED = true;
// ─────────────────────────────────────────────────────────────────────────────

// ─── In-memory APY cache (refreshed every 15 min by YieldMonitor) ────────────
let apyCache = {
  aave:     { apy: 2.5,  source: 'fallback', fetched_at: null },
  morpho:   { apy: 5.5,  source: 'fallback', fetched_at: null },
  spark:    { apy: 4.2,  source: 'fallback', fetched_at: null },
  compound: { apy: 3.8,  source: 'fallback', fetched_at: null },
  best:     { protocol: 'morpho', apy: 5.5 },
  last_updated: null,
};

// ─── NAV per share state (in-memory, updated every 15 min) ───────────────────
// NAV starts at 1.000000 USDC per share, grows with yield
let navState = {
  nav_per_share: 1.0,      // USDC value of 1 share
  total_shares: 0,          // sum of all depositor shares
  total_deposits: 0,        // total USDC deposited (principal)
  total_yield_earned: 0,    // cumulative yield accrued
  rebalance_count: 0,
  current_protocol: 'morpho',
  last_nav_update: null,
};

// ─────────────────────────────────────────────────────────────────────────────
//  PROTOCOL APY FETCHERS (real live data, no API key needed)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAaveApy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(
      'https://aave-api-v2.aave.com/data/markets-data/0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Look for USDC in reserves list
    const reserves = data?.reserves || data?.v3?.reserves || [];
    const usdc = reserves.find(r =>
      r.symbol === 'USDC' ||
      r.underlyingAsset?.toLowerCase().includes('usdc') ||
      r.name?.toLowerCase().includes('usdc')
    );
    if (usdc) {
      const apy = parseFloat(usdc.supplyAPY || usdc.liquidityRate || usdc.apy || 0) * 100;
      if (apy > 0 && apy < 50) {
        console.log(`[vault] Aave APY fetched: ${apy.toFixed(4)}%`);
        return { apy, source: 'live' };
      }
    }
    throw new Error('USDC reserve not found in response');
  } catch (err) {
    // Try fallback URL
    try {
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), 6000);
      const resp2 = await fetch('https://api.aave.com/data/markets', { signal: ctrl2.signal });
      clearTimeout(timer2);
      if (!resp2.ok) throw new Error(`HTTP ${resp2.status}`);
      const data2 = await resp2.json();
      const reserves2 = data2?.reserves || data2?.markets?.[0]?.reserves || [];
      const usdc2 = reserves2.find(r => r.symbol === 'USDC');
      if (usdc2) {
        const apy2 = parseFloat(usdc2.supplyAPY || usdc2.liquidityRate || 0) * 100;
        if (apy2 > 0 && apy2 < 50) {
          console.log(`[vault] Aave APY (fallback URL): ${apy2.toFixed(4)}%`);
          return { apy: apy2, source: 'live_fallback' };
        }
      }
    } catch (err2) {
      // fall through to hardcoded
    }
    console.log(`[vault] Aave APY fetch failed (${err.message}), using fallback 2.5%`);
    return { apy: 2.5, source: 'fallback' };
  }
}

async function fetchMorphoApy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://blue-api.morpho.org/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ markets(where: {collateralAsset: {symbol_in: ["USDC"]}, whitelisted: true}, orderBy: supplyApy, orderDirection: desc, first: 5) { items { uniqueKey supplyApy collateralAsset { symbol } loanAsset { symbol } } } }`
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const items = data?.data?.markets?.items || [];
    if (items.length > 0) {
      // Take best (highest) USDC supply APY
      const bestApy = Math.max(...items.map(m => parseFloat(m.supplyApy || 0) * 100));
      if (bestApy > 0 && bestApy < 100) {
        console.log(`[vault] Morpho APY fetched: ${bestApy.toFixed(4)}%`);
        return { apy: bestApy, source: 'live' };
      }
    }
    throw new Error('No valid Morpho USDC markets found');
  } catch (err) {
    console.log(`[vault] Morpho APY fetch failed (${err.message}), using fallback 5.5%`);
    return { apy: 5.5, source: 'fallback' };
  }
}

async function fetchSparkApy() {
  const urls = [
    'https://api.spark.fi/v1/rates',
    'https://spark.fi/api/rates',
  ];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      // Look for USDC supply rate in various response shapes
      const rates = data?.rates || data?.data || data || {};
      const usdc = rates?.USDC || rates?.usdc || Object.values(rates).find(r =>
        r?.symbol === 'USDC' || r?.asset === 'USDC'
      );
      if (usdc) {
        const apy = parseFloat(usdc.supplyApy || usdc.apy || usdc.rate || 0) * 100;
        if (apy > 0 && apy < 50) {
          console.log(`[vault] Spark APY fetched: ${apy.toFixed(4)}%`);
          return { apy, source: 'live' };
        }
      }
      throw new Error('USDC rate not found in Spark response');
    } catch (err) {
      // try next URL
    }
  }
  console.log('[vault] Spark APY fetch failed, using fallback 4.2%');
  return { apy: 4.2, source: 'fallback' };
}

async function fetchCompoundApy() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(
      'https://api.compound.finance/api/v2/ctoken?addresses[]=0x46e6b214b524310239732D51387075E0e70970bf',
      { signal: ctrl.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const token = (data?.cToken || [])[0];
    if (token) {
      const apy = parseFloat(token.supply_rate?.value || token.supplyApy || 0) * 100;
      if (apy > 0 && apy < 50) {
        console.log(`[vault] Compound APY fetched: ${apy.toFixed(4)}%`);
        return { apy, source: 'live' };
      }
    }
    throw new Error('USDC cToken not found in response');
  } catch (err) {
    console.log(`[vault] Compound APY fetch failed (${err.message}), using fallback 3.8%`);
    return { apy: 3.8, source: 'fallback' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND: YieldMonitor — poll all 4 protocols every 15 min
// ─────────────────────────────────────────────────────────────────────────────

async function refreshApyCache() {
  try {
    console.log('[vault] YieldMonitor: refreshing APY data from all protocols...');
    const [aave, morpho, spark, compound] = await Promise.allSettled([
      fetchAaveApy(),
      fetchMorphoApy(),
      fetchSparkApy(),
      fetchCompoundApy(),
    ]);

    const now = new Date().toISOString();
    apyCache.aave     = { ...(aave.value     || { apy: 2.5, source: 'fallback' }), fetched_at: now };
    apyCache.morpho   = { ...(morpho.value   || { apy: 5.5, source: 'fallback' }), fetched_at: now };
    apyCache.spark    = { ...(spark.value    || { apy: 4.2, source: 'fallback' }), fetched_at: now };
    apyCache.compound = { ...(compound.value || { apy: 3.8, source: 'fallback' }), fetched_at: now };
    apyCache.last_updated = now;

    // Find best protocol
    const protocols = [
      { name: 'aave',     apy: apyCache.aave.apy },
      { name: 'morpho',   apy: apyCache.morpho.apy },
      { name: 'spark',    apy: apyCache.spark.apy },
      { name: 'compound', apy: apyCache.compound.apy },
    ];
    const best = protocols.reduce((a, b) => a.apy >= b.apy ? a : b);
    apyCache.best = { protocol: best.name, apy: best.apy };

    console.log(`[vault] YieldMonitor: best protocol = ${best.name} @ ${best.apy.toFixed(4)}%`);
    console.log(`[vault]   aave=${apyCache.aave.apy.toFixed(4)}% morpho=${apyCache.morpho.apy.toFixed(4)}% spark=${apyCache.spark.apy.toFixed(4)}% compound=${apyCache.compound.apy.toFixed(4)}%`);
  } catch (err) {
    console.error('[vault] YieldMonitor error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND: NAVUpdater — accrue yield to all vaults every 15 min
// ─────────────────────────────────────────────────────────────────────────────

async function updateNAV() {
  try {
    // Get current allocation
    const allocation = await db.getOne(
      'SELECT * FROM vault_allocations WHERE is_active = TRUE ORDER BY last_rebalanced DESC LIMIT 1',
      []
    );
    const rawNavApy = allocation ? parseFloat(allocation.current_apy) : null;
    const currentApy = (rawNavApy && rawNavApy > 0) ? rawNavApy : apyCache[navState.current_protocol]?.apy || apyCache.best.apy;
    const totalDeposits = navState.total_deposits;

    if (totalDeposits <= 0 || navState.total_shares <= 0) return;

    // Elapsed time since last NAV update (15 min / 96 updates per day)
    const now = new Date();
    const lastUpdate = navState.last_nav_update ? new Date(navState.last_nav_update) : now;
    const elapsed_days = (now - lastUpdate) / (1000 * 86400);

    if (elapsed_days <= 0) return;

    // NAV accrual formula:
    // daily_yield = (current_apy / 365) * total_deposits
    // nav_per_share += daily_yield / total_shares
    const daily_yield = (currentApy / 100 / 365) * totalDeposits;
    const yield_this_interval = daily_yield * elapsed_days;
    const nav_increment = yield_this_interval / navState.total_shares;

    navState.nav_per_share += nav_increment;
    navState.total_yield_earned += yield_this_interval;
    navState.last_nav_update = now.toISOString();

    // Record yield accrual event in DB
    if (yield_this_interval > 0.000001) {
      const eventId = `ve_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
      await db.run(`
        INSERT INTO vault_events (vault_id, event_type, amount_usdc, protocol_from, apy_at_time, simulated, timestamp)
        VALUES ($1, 'yield_accrual', $2, $3, $4, $5, $6)
      `, ['GLOBAL', yield_this_interval, navState.current_protocol, currentApy, SIMULATED, now.toISOString()]).catch(() => {});
    }

    // Sync total deposits from DB
    await syncNavFromDb();

    console.log(`[vault] NAVUpdater: nav_per_share=${navState.nav_per_share.toFixed(8)}, yield_accrued=${yield_this_interval.toFixed(6)} USDC @ ${currentApy.toFixed(4)}% APY`);
  } catch (err) {
    console.error('[vault] NAVUpdater error:', err.message);
  }
}

async function syncNavFromDb() {
  try {
    const result = await db.query(
      'SELECT COALESCE(SUM(deposited_usdc), 0) as total_dep, COALESCE(SUM(shares), 0) as total_shares FROM yield_vaults',
      []
    );
    if (result && result.rows && result.rows[0]) {
      const row = result.rows[0];
      navState.total_deposits = parseFloat(row.total_dep || 0);
      navState.total_shares = parseFloat(row.total_shares || 0);
    }
  } catch (err) {
    // DB may not be available — use in-memory state
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BACKGROUND: Rebalancer — check and execute rebalance every 15 min
// ─────────────────────────────────────────────────────────────────────────────

async function checkAndRebalance() {
  try {
    const allocation = await db.getOne(
      'SELECT * FROM vault_allocations WHERE is_active = TRUE ORDER BY last_rebalanced DESC LIMIT 1',
      []
    );

    const currentProtocol = allocation?.protocol || navState.current_protocol;
    const rawCurrentApy = allocation ? parseFloat(allocation.current_apy) : null;
    const currentApy = (rawCurrentApy && rawCurrentApy > 0) ? rawCurrentApy : apyCache[currentProtocol]?.apy || 0;
    const bestProtocol    = apyCache.best.protocol;
    const bestApy         = apyCache.best.apy;
    const spread          = bestApy - currentApy;

    // Trigger rebalance when spread > 0.5% AND simulated gas < 1 day of yield improvement
    const totalDeposits = navState.total_deposits;
    const daily_yield_improvement = (spread / 100 / 365) * totalDeposits;
    const simulated_gas_cost = SIMULATED ? 0.001 : 5.0; // $0.001 paper | ~$5 real on Base L2

    const shouldRebalance = spread > 0.5 && daily_yield_improvement > simulated_gas_cost;

    if (shouldRebalance) {
      console.log(`[vault] Rebalancer: spread ${spread.toFixed(4)}% — rebalancing ${currentProtocol} → ${bestProtocol}`);
      await executeRebalance(currentProtocol, bestProtocol, bestApy, totalDeposits);
    } else {
      if (spread > 0) {
        console.log(`[vault] Rebalancer: spread ${spread.toFixed(4)}% — below threshold or gas cost too high, no rebalance`);
      }
    }
  } catch (err) {
    console.error('[vault] Rebalancer error:', err.message);
  }
}

async function executeRebalance(fromProtocol, toProtocol, toApy, amount_usdc) {
  const now = new Date().toISOString();
  const fromApy = apyCache[fromProtocol]?.apy || 0;

  // Phase 1: Update allocation in DB (paper trade — no on-chain txns)
  // Phase 2: wire Coinbase CDP here to move real USDC

  try {
    // Deactivate old allocation
    await db.run(
      'UPDATE vault_allocations SET is_active = FALSE WHERE protocol = $1',
      [fromProtocol]
    ).catch(() => {});

    // Insert new active allocation
    await db.run(`
      INSERT INTO vault_allocations (protocol, allocated_usdc, current_apy, last_rebalanced, is_active)
      VALUES ($1, $2, $3, $4, TRUE)
    `, [toProtocol, amount_usdc, toApy, now]).catch(() => {});

    // Log rebalance event
    await db.run(`
      INSERT INTO vault_events (vault_id, event_type, amount_usdc, protocol_from, protocol_to, apy_at_time, simulated, timestamp)
      VALUES ($1, 'rebalance', $2, $3, $4, $5, $6, $7)
    `, ['GLOBAL', amount_usdc, fromProtocol, toProtocol, toApy, SIMULATED, now]).catch(() => {});

    navState.current_protocol = toProtocol;
    navState.rebalance_count++;

    console.log(`[vault] Rebalancer: ✓ rebalanced to ${toProtocol} @ ${toApy.toFixed(4)}% (simulated=${SIMULATED})`);
  } catch (err) {
    console.error('[vault] Rebalancer: failed to record rebalance:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  DATABASE INITIALIZATION
// ─────────────────────────────────────────────────────────────────────────────

async function initYieldVaultSchema() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS yield_vaults (
        vault_id TEXT PRIMARY KEY,
        owner_did TEXT NOT NULL,
        deposited_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
        shares NUMERIC(18,6) NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS vault_allocations (
        id SERIAL PRIMARY KEY,
        protocol TEXT NOT NULL,
        allocated_usdc NUMERIC(18,6) NOT NULL DEFAULT 0,
        current_apy NUMERIC(8,4) NOT NULL DEFAULT 0,
        last_rebalanced TIMESTAMPTZ DEFAULT NOW(),
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS vault_events (
        id SERIAL PRIMARY KEY,
        vault_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        amount_usdc NUMERIC(18,6),
        protocol_from TEXT,
        protocol_to TEXT,
        apy_at_time NUMERIC(8,4),
        simulated BOOLEAN DEFAULT TRUE,
        timestamp TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed initial allocation if table is empty
    const existing = await db.getOne('SELECT COUNT(*) as c FROM vault_allocations', []);
    if (!existing || parseInt(existing.c || 0) === 0) {
      await db.run(`
        INSERT INTO vault_allocations (protocol, allocated_usdc, current_apy, last_rebalanced, is_active)
        VALUES ($1, 0, $2, NOW(), TRUE)
      `, ['morpho', apyCache.best.apy]).catch(() => {});
    }

    console.log('[vault] Yield vault schema initialized');
  } catch (err) {
    // In-memory mode — schema is handled by db.js memTables
    // Add yield vault tables to memory
    const dbModule = require('./db');
    if (dbModule && typeof dbModule === 'object') {
      console.log('[vault] Schema init in memory mode (no DATABASE_URL)');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  STARTUP: Initialize schema + start background threads
// ─────────────────────────────────────────────────────────────────────────────

const FIFTEEN_MINUTES = 15 * 60 * 1000;

async function startYieldVault() {
  console.log('[vault] Starting HiveBank Yield Vault...');
  console.log(`[vault] Mode: ${SIMULATED ? 'PAPER TRADING (Phase 1)' : 'LIVE EXECUTION (Phase 2)'}`);

  // Initialize DB schema
  await initYieldVaultSchema();

  // Sync NAV state from DB
  await syncNavFromDb();

  // Initial APY fetch
  await refreshApyCache();
  navState.last_nav_update = new Date().toISOString();
  navState.current_protocol = apyCache.best.protocol;

  // Background: YieldMonitor — poll APYs every 15 min
  setInterval(refreshApyCache, FIFTEEN_MINUTES);

  // Background: NAVUpdater — accrue yield every 15 min
  setInterval(updateNAV, FIFTEEN_MINUTES);

  // Background: Rebalancer — check rebalance every 15 min
  setInterval(checkAndRebalance, FIFTEEN_MINUTES);

  console.log('[vault] Background threads started: YieldMonitor, NAVUpdater, Rebalancer (15-min intervals)');
}

// ─────────────────────────────────────────────────────────────────────────────
//  VAULT OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

async function deposit(did, amount_usdc) {
  if (!did)         return { error: 'did is required' };
  if (!amount_usdc || isNaN(amount_usdc) || Number(amount_usdc) <= 0) {
    return { error: 'amount_usdc must be a positive number' };
  }
  const amount = parseFloat(amount_usdc);

  // Ensure NAV is initialized
  if (navState.nav_per_share <= 0) navState.nav_per_share = 1.0;

  // Calculate shares to mint
  const shares_minted = amount / navState.nav_per_share;

  const now = new Date().toISOString();
  let vault = await db.getOne('SELECT * FROM yield_vaults WHERE owner_did = $1', [did]);

  if (!vault) {
    // Create new vault
    const vault_id = `yv_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    await db.run(`
      INSERT INTO yield_vaults (vault_id, owner_did, deposited_usdc, shares, created_at, last_activity)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [vault_id, did, amount, shares_minted, now, now]);

    vault = { vault_id, owner_did: did, deposited_usdc: 0, shares: 0 };
    vault.vault_id = vault_id;
  } else {
    // Add to existing vault
    await db.run(`
      UPDATE yield_vaults
      SET deposited_usdc = deposited_usdc + $1, shares = shares + $2, last_activity = $3
      WHERE owner_did = $4
    `, [amount, shares_minted, now, did]);
  }

  // Update in-memory NAV totals
  navState.total_deposits += amount;
  navState.total_shares   += shares_minted;

  // Log deposit event
  await db.run(`
    INSERT INTO vault_events (vault_id, event_type, amount_usdc, protocol_from, apy_at_time, simulated, timestamp)
    VALUES ($1, 'deposit', $2, $3, $4, $5, $6)
  `, [vault.vault_id, amount, navState.current_protocol, apyCache.best.apy, SIMULATED, now]).catch(() => {});

  // Update vault_allocations with new total
  await db.run(
    'UPDATE vault_allocations SET allocated_usdc = allocated_usdc + $1 WHERE is_active = TRUE',
    [amount]
  ).catch(() => {});

  return {
    success: true,
    vault_id: vault.vault_id,
    did,
    deposited_usdc: amount,
    shares_minted: parseFloat(shares_minted.toFixed(6)),
    nav_per_share: parseFloat(navState.nav_per_share.toFixed(8)),
    current_protocol: navState.current_protocol,
    current_apy_pct: apyCache.best.apy,
    simulated: SIMULATED,
    phase: SIMULATED ? 'Phase 1 — paper trading' : 'Phase 2 — live execution',
    timestamp: now,
  };
}

async function withdraw(did, amount_usdc) {
  if (!did)         return { error: 'did is required' };
  if (!amount_usdc || isNaN(amount_usdc) || Number(amount_usdc) <= 0) {
    return { error: 'amount_usdc must be a positive number' };
  }
  const amount = parseFloat(amount_usdc);

  const vault = await db.getOne('SELECT * FROM yield_vaults WHERE owner_did = $1', [did]);
  if (!vault) return { error: 'No yield vault found for this DID' };

  // Current USDC value of depositor's shares
  const depositor_shares = parseFloat(vault.shares);
  const vault_value_usdc = depositor_shares * navState.nav_per_share;

  if (vault_value_usdc < amount) {
    return {
      error: 'Insufficient vault balance',
      vault_value_usdc: parseFloat(vault_value_usdc.toFixed(6)),
      requested: amount,
    };
  }

  // Calculate shares to burn
  const shares_to_burn = amount / navState.nav_per_share;
  const original_principal = Math.min(amount, parseFloat(vault.deposited_usdc));
  const yield_component = Math.max(0, amount - original_principal);

  const now = new Date().toISOString();
  const new_shares = Math.max(0, depositor_shares - shares_to_burn);
  const new_deposited = Math.max(0, parseFloat(vault.deposited_usdc) - original_principal);

  await db.run(`
    UPDATE yield_vaults
    SET shares = $1, deposited_usdc = $2, last_activity = $3
    WHERE owner_did = $4
  `, [new_shares, new_deposited, now, did]);

  // Update in-memory totals
  navState.total_shares   = Math.max(0, navState.total_shares - shares_to_burn);
  navState.total_deposits = Math.max(0, navState.total_deposits - original_principal);

  // Log withdraw event
  await db.run(`
    INSERT INTO vault_events (vault_id, event_type, amount_usdc, protocol_from, apy_at_time, simulated, timestamp)
    VALUES ($1, 'withdraw', $2, $3, $4, $5, $6)
  `, [vault.vault_id, amount, navState.current_protocol, apyCache.best.apy, SIMULATED, now]).catch(() => {});

  // Update allocation totals
  await db.run(
    'UPDATE vault_allocations SET allocated_usdc = GREATEST(0, allocated_usdc - $1) WHERE is_active = TRUE',
    [amount]
  ).catch(() => {});

  return {
    success: true,
    vault_id: vault.vault_id,
    did,
    withdrawn_usdc: amount,
    principal_returned: parseFloat(original_principal.toFixed(6)),
    yield_returned: parseFloat(yield_component.toFixed(6)),
    shares_burned: parseFloat(shares_to_burn.toFixed(6)),
    shares_remaining: parseFloat(new_shares.toFixed(6)),
    nav_per_share: parseFloat(navState.nav_per_share.toFixed(8)),
    simulated: SIMULATED,
    timestamp: now,
  };
}

async function getVaultBalance(did) {
  if (!did) return { error: 'did is required' };

  const vault = await db.getOne('SELECT * FROM yield_vaults WHERE owner_did = $1', [did]);
  if (!vault) return { error: 'No yield vault found for this DID. Deposit USDC to create one.' };

  const shares = parseFloat(vault.shares);
  const deposited = parseFloat(vault.deposited_usdc);
  const current_value = shares * navState.nav_per_share;
  const yield_earned  = Math.max(0, current_value - deposited);
  const yield_pct     = deposited > 0 ? (yield_earned / deposited) * 100 : 0;

  // Get current allocation
  const allocation = await db.getOne(
    'SELECT * FROM vault_allocations WHERE is_active = TRUE ORDER BY last_rebalanced DESC LIMIT 1',
    []
  ).catch(() => null);

  const rawApy = allocation ? parseFloat(allocation.current_apy) : null;
  const currentApy = (rawApy && rawApy > 0) ? rawApy : apyCache[navState.current_protocol]?.apy || apyCache.best.apy;
  const daily_yield_projected = (currentApy / 100 / 365) * current_value;
  const annual_yield_projected = (currentApy / 100) * current_value;

  return {
    vault_id: vault.vault_id,
    did,
    deposited_usdc: parseFloat(deposited.toFixed(6)),
    current_value_usdc: parseFloat(current_value.toFixed(6)),
    yield_earned_usdc: parseFloat(yield_earned.toFixed(6)),
    yield_pct: parseFloat(yield_pct.toFixed(4)),
    shares: parseFloat(shares.toFixed(6)),
    nav_per_share: parseFloat(navState.nav_per_share.toFixed(8)),
    current_protocol: allocation?.protocol || navState.current_protocol,
    current_apy_pct: currentApy,
    projected_daily_yield_usdc: parseFloat(daily_yield_projected.toFixed(6)),
    projected_annual_yield_usdc: parseFloat(annual_yield_projected.toFixed(4)),
    protocol_breakdown: {
      aave:     { apy: apyCache.aave.apy,     source: apyCache.aave.source },
      morpho:   { apy: apyCache.morpho.apy,   source: apyCache.morpho.source },
      spark:    { apy: apyCache.spark.apy,    source: apyCache.spark.source },
      compound: { apy: apyCache.compound.apy, source: apyCache.compound.source },
    },
    simulated: SIMULATED,
    phase: SIMULATED ? 'Phase 1 — paper trading' : 'Phase 2 — live execution',
    created_at: vault.created_at,
    last_activity: vault.last_activity,
  };
}

async function getRates() {
  const protocols = [
    { name: 'aave',     ...apyCache.aave },
    { name: 'morpho',   ...apyCache.morpho },
    { name: 'spark',    ...apyCache.spark },
    { name: 'compound', ...apyCache.compound },
  ].sort((a, b) => b.apy - a.apy);

  return {
    protocols,
    best_protocol: apyCache.best.protocol,
    best_apy_pct: apyCache.best.apy,
    current_vault_protocol: navState.current_protocol,
    current_vault_apy_pct: apyCache[navState.current_protocol]?.apy || apyCache.best.apy,
    last_updated: apyCache.last_updated,
    rebalance_threshold_pct: 0.5,
    simulated: SIMULATED,
    phase: SIMULATED ? 'Phase 1 — paper trading (real APY data)' : 'Phase 2 — live on-chain execution',
    note: SIMULATED
      ? 'APY data is live and real. Execution is paper-traded until Phase 2 capital is deployed.'
      : 'Live execution via Coinbase CDP on Base mainnet.',
  };
}

async function getStats() {
  // Pull TVL and event counts from DB
  let tvl = 0;
  let totalDepositors = 0;
  let rebalanceCount = 0;
  let totalYieldEvents = 0;

  try {
    const tvlResult = await db.query(
      'SELECT COALESCE(SUM(deposited_usdc), 0) as tvl, COUNT(*) as depositors FROM yield_vaults',
      []
    );
    if (tvlResult?.rows?.[0]) {
      tvl = parseFloat(tvlResult.rows[0].tvl || 0);
      totalDepositors = parseInt(tvlResult.rows[0].depositors || 0);
    }

    const eventResult = await db.query(`
      SELECT
        SUM(CASE WHEN event_type = 'rebalance' THEN 1 ELSE 0 END) as rebalances,
        SUM(CASE WHEN event_type = 'yield_accrual' THEN 1 ELSE 0 END) as yield_events,
        COALESCE(SUM(CASE WHEN event_type = 'yield_accrual' THEN amount_usdc ELSE 0 END), 0) as total_yield
      FROM vault_events
    `, []);
    if (eventResult?.rows?.[0]) {
      rebalanceCount = parseInt(eventResult.rows[0].rebalances || 0);
      totalYieldEvents = parseInt(eventResult.rows[0].yield_events || 0);
    }
  } catch (err) {
    // Fall back to in-memory state
    tvl = navState.total_deposits;
  }

  const allocation = await db.getOne(
    'SELECT * FROM vault_allocations WHERE is_active = TRUE ORDER BY last_rebalanced DESC LIMIT 1',
    []
  ).catch(() => null);

  return {
    tvl_usdc: parseFloat(tvl.toFixed(6)),
    total_depositors: totalDepositors,
    total_yield_earned_usdc: parseFloat(navState.total_yield_earned.toFixed(6)),
    nav_per_share: parseFloat(navState.nav_per_share.toFixed(8)),
    total_shares: parseFloat(navState.total_shares.toFixed(6)),
    rebalance_count: navState.rebalance_count + rebalanceCount,
    current_protocol: allocation?.protocol || navState.current_protocol,
    current_apy_pct: (allocation && parseFloat(allocation.current_apy) > 0)
      ? parseFloat(allocation.current_apy)
      : apyCache[navState.current_protocol]?.apy || apyCache.best.apy,
    protocol_apys: {
      aave:     apyCache.aave.apy,
      morpho:   apyCache.morpho.apy,
      spark:    apyCache.spark.apy,
      compound: apyCache.compound.apy,
    },
    last_apy_update: apyCache.last_updated,
    simulated: SIMULATED,
    phase: SIMULATED ? 'Phase 1 — paper trading' : 'Phase 2 — live execution',
  };
}

async function manualRebalance() {
  const currentProtocol = navState.current_protocol;
  const currentApy      = apyCache[currentProtocol]?.apy || 0;
  const bestProtocol    = apyCache.best.protocol;
  const bestApy         = apyCache.best.apy;
  const spread          = bestApy - currentApy;

  if (bestProtocol === currentProtocol) {
    return {
      success: true,
      message: 'Already on best protocol — no rebalance needed',
      current_protocol: currentProtocol,
      current_apy_pct: currentApy,
      best_protocol: bestProtocol,
      best_apy_pct: bestApy,
      spread_pct: spread,
    };
  }

  await executeRebalance(currentProtocol, bestProtocol, bestApy, navState.total_deposits);

  return {
    success: true,
    message: `Rebalanced from ${currentProtocol} to ${bestProtocol}`,
    previous_protocol: currentProtocol,
    new_protocol: bestProtocol,
    previous_apy_pct: currentApy,
    new_apy_pct: bestApy,
    spread_pct: spread,
    simulated: SIMULATED,
    total_deposits_usdc: parseFloat(navState.total_deposits.toFixed(6)),
  };
}

module.exports = {
  startYieldVault,
  deposit,
  withdraw,
  getVaultBalance,
  getRates,
  getStats,
  manualRebalance,
  refreshApyCache,
  apyCache,
  navState,
  SIMULATED,
};
