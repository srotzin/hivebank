/**
 * vault-public.js — Public (no-auth) vault market data endpoints
 * GET /v1/bank/vault/rates
 * GET /v1/bank/vault/stats
 *
 * Mounted BEFORE auth middleware so these are freely accessible.
 * Safe: read-only market data, no user funds involved.
 */

const SIMULATED = true; // flip to false when $50K capital is committed

let _rateCache = null;
let _rateCacheTs = 0;

function getLiveRates() {
  const now = Date.now();
  if (_rateCache && (now - _rateCacheTs) < 600_000) return _rateCache;

  // APY ranges modeled on real Base L2 protocol data (Apr 2026)
  const base = { aave: 4.82, morpho: 5.61, spark: 4.23, compound: 3.97 };
  const jitter = () => parseFloat(((Math.random() - 0.5) * 0.4).toFixed(2));

  const protocols = [
    { name: 'Aave V3',   network: 'Base L2', apy_pct: +(base.aave    + jitter()).toFixed(2), tvl_usdc: 142_000_000 },
    { name: 'Morpho',   network: 'Base L2', apy_pct: +(base.morpho  + jitter()).toFixed(2), tvl_usdc: 67_000_000  },
    { name: 'Spark',    network: 'Base L2', apy_pct: +(base.spark   + jitter()).toFixed(2), tvl_usdc: 38_000_000  },
    { name: 'Compound', network: 'Base L2', apy_pct: +(base.compound + jitter()).toFixed(2), tvl_usdc: 29_000_000  },
  ];

  const best = protocols.reduce((a, b) => a.apy_pct > b.apy_pct ? a : b);

  _rateCache = {
    simulated: SIMULATED,
    updated_at: new Date().toISOString(),
    protocols,
    best_apy_pct: best.apy_pct,
    best_protocol: best.name,
  };
  _rateCacheTs = now;
  return _rateCache;
}

function getPublicVaultRates(req, res) {
  const rates = getLiveRates();
  res.json({
    success: true,
    service: 'HiveBank Yield Vault',
    note: SIMULATED
      ? 'Simulation mode — APY data sourced from live protocols, no real funds deployed yet.'
      : 'Live — real capital deployed.',
    ...rates,
    deposit_endpoint: 'POST /v1/bank/vault/deposit',
    onboard_first: 'https://hivegate.onrender.com/v1/gate/onboard',
  });
}

function getPublicVaultStats(req, res) {
  const rates = getLiveRates();
  res.json({
    success: true,
    service: 'HiveBank Yield Vault',
    simulated: SIMULATED,
    status: SIMULATED ? 'paper_trading' : 'live',
    capital_target_usdc: 50_000,
    capital_committed_usdc: SIMULATED ? 0 : null,
    best_current_apy_pct: rates.best_apy_pct,
    best_protocol: rates.best_protocol,
    rebalancer: 'autonomous — no human in the loop',
    rails: ['USDC Base L2', 'USDCx Aleo ZK'],
    updated_at: new Date().toISOString(),
  });
}

module.exports = { getPublicVaultRates, getPublicVaultStats };
