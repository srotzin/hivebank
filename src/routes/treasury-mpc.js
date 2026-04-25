/**
 * treasury-mpc.js — HiveWallet MPC Treasury API
 *
 * "Better than Ledger. Ledger holds. Hive acts."
 *
 * Ledger: $150 device. Seed phrase on paper. Passive. Can't earn.
 *         Can't hedge. Can't route. Requires you to be awake.
 *
 * HiveWallet MPC: Zero device. Keys split 3 ways (Coinbase/Hive/You).
 *         Active. Earns. Hedges. Routes. Works while you sleep.
 *         CLOAzK cert on every transaction. Aleo ZK on exit if needed.
 *
 * SUPPORTED: ETH, USDC, SOL, BTC, DOGE, MATIC, AVAX, LTC, XRP + 100 more
 * All via your existing Coinbase CDP API key. No new accounts.
 *
 * ENDPOINTS:
 *   GET  /v1/treasury/info                    — product sheet + supported assets
 *   GET  /v1/treasury/status                  — wallet status + init check
 *   GET  /v1/treasury/balances                — all asset balances live
 *   GET  /v1/treasury/address?asset=ETH       — deposit address for any asset
 *   POST /v1/treasury/send                    — send any asset to any address
 *   POST /v1/treasury/trade                   — swap ETH→USDC, SOL→ETH, etc.
 *   GET  /v1/treasury/history                 — transfer history
 *   POST /v1/treasury/price                   — live price + P&L for held assets
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const db       = require('../services/db');
const mpc      = require('../services/mpc-treasury');

// Leaked-key purge 2026-04-25: lazy read, fail closed if env missing.
const { getInternalKey } = require('../lib/internal-key');

// Price cache — refreshed every 60s
let prices = { ETH: 3512, SOL: 172, BTC: 67420, DOGE: 0.17, ALEO: 0.046, USDC: 1, MATIC: 0.55, AVAX: 35, LTC: 82, XRP: 0.52 };
let priceTs = 0;

async function refreshPrices() {
  if (Date.now() - priceTs < 60000) return prices;
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,bitcoin,dogecoin,aleo-network,matic-network,avalanche-2,litecoin,ripple&vs_currencies=usd',
      { headers: { 'User-Agent': 'HiveTreasury/1.0' }, signal: AbortSignal.timeout(6000) }
    );
    if (r.ok) {
      const d = await r.json();
      prices.ETH   = d['ethereum']?.usd      || prices.ETH;
      prices.SOL   = d['solana']?.usd         || prices.SOL;
      prices.BTC   = d['bitcoin']?.usd        || prices.BTC;
      prices.DOGE  = d['dogecoin']?.usd       || prices.DOGE;
      prices.ALEO  = d['aleo-network']?.usd   || prices.ALEO;
      prices.MATIC = d['matic-network']?.usd  || prices.MATIC;
      prices.AVAX  = d['avalanche-2']?.usd    || prices.AVAX;
      prices.LTC   = d['litecoin']?.usd       || prices.LTC;
      prices.XRP   = d['ripple']?.usd         || prices.XRP;
      priceTs = Date.now();
    }
  } catch (_) {}
  return prices;
}

// Auth — require internal key or DID header
function requireAuth(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-key'];
  const did = req.headers['x-hive-did'];
  if ((key && key === getInternalKey()) || did) return next();
  return res.status(401).json({ error: 'x-hive-did or x-hive-internal required' });
}

// DB bootstrap
async function ensureTables() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS mpc_transfers (
      id          SERIAL PRIMARY KEY,
      asset       TEXT NOT NULL,
      amount      NUMERIC(18,8) NOT NULL,
      to_address  TEXT,
      from_did    TEXT,
      to_did      TEXT,
      tx_hash     TEXT,
      network     TEXT,
      status      TEXT DEFAULT 'pending',
      memo        TEXT,
      usd_value   NUMERIC(18,4),
      fee_usd     NUMERIC(10,4),
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS mpc_holdings (
      id          SERIAL PRIMARY KEY,
      asset       TEXT NOT NULL,
      amount      NUMERIC(18,8) NOT NULL,
      entry_price NUMERIC(18,4),
      entry_usd   NUMERIC(18,4),
      network     TEXT,
      acquired_at TIMESTAMPTZ DEFAULT NOW(),
      notes       TEXT
    );
  `);
}
ensureTables().catch(e => console.error('[MPC treasury] tables:', e));

// ── GET /info ─────────────────────────────────────────────────────────────────

router.get('/info', async (req, res) => {
  await refreshPrices();
  res.json({
    product: 'HiveWallet MPC Treasury',
    tagline: 'Better than Ledger. Ledger holds. Hive acts.',
    vs_ledger: {
      ledger:  ['$150 device', 'seed phrase on paper', 'passive vault', 'cannot earn', 'cannot hedge', 'requires you to be awake', 'single point of failure'],
      hive:    ['zero device', 'MPC key split 3 ways', 'active treasury', 'earns yield', 'auto-hedges', 'works while you sleep', 'no single point of failure'],
    },
    security_model: {
      type: 'MPC (Multi-Party Computation)',
      shards: ['Coinbase holds shard A', 'Hive holds shard B', 'You hold shard C (optional)'],
      guarantee: 'No single party can move funds alone. Both Coinbase + Hive must co-sign.',
      vs_hardware_wallet: 'Ledger can be stolen or lost. MPC has no physical device to steal.',
    },
    supported_assets: {
      ETH:   { network: 'Base / Ethereum / Arbitrum', price_usd: prices.ETH,  note: 'Hold for appreciation, earn yield, auto-hedge' },
      USDC:  { network: 'Base / Ethereum / Solana',   price_usd: 1.00,        note: 'Stable. Used for all internal settlements' },
      SOL:   { network: 'Solana',                     price_usd: prices.SOL,  note: 'Hold, send, receive from Phantom/Coinbase' },
      BTC:   { network: 'Bitcoin',                    price_usd: prices.BTC,  note: 'Digital gold. Hold for appreciation' },
      DOGE:  { network: 'Dogecoin',                   price_usd: prices.DOGE, note: 'Hold. Coinbase MPC native support' },
      ALEO:  { network: 'Aleo mainnet',               price_usd: prices.ALEO, note: 'Mine it, hold it, earn ZK proof fees' },
      MATIC: { network: 'Polygon',                    price_usd: prices.MATIC,note: 'Polygon ecosystem' },
      AVAX:  { network: 'Avalanche',                  price_usd: prices.AVAX, note: 'Avalanche ecosystem' },
      LTC:   { network: 'Litecoin',                   price_usd: prices.LTC,  note: 'Fast Bitcoin alternative' },
      XRP:   { network: 'XRP Ledger',                 price_usd: prices.XRP,  note: 'Cross-border settlement' },
    },
    what_ledger_cant_do: [
      'Auto-hedge ETH when it drops 5% (mining hedge pattern)',
      'Earn 6% APY on idle USDC (HiveVault)',
      'Pay another agent with one API call',
      'Route to cheapest rail automatically on exit',
      'CLOAzK compliance cert on every transaction',
      'Aleo ZK privacy on large transfers',
      'Work while you sleep',
    ],
    endpoints: {
      status:   'GET  /v1/treasury/status',
      balances: 'GET  /v1/treasury/balances',
      address:  'GET  /v1/treasury/address?asset=ETH',
      send:     'POST /v1/treasury/send',
      trade:    'POST /v1/treasury/trade',
      history:  'GET  /v1/treasury/history',
      prices:   'GET  /v1/treasury/prices',
    },
    powered_by: 'Coinbase MPC Developer Platform (CDP)',
    note: 'Your existing Coinbase CDP API key unlocks this. No new accounts.',
  });
});

// ── GET /status ───────────────────────────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
  const result = await mpc.init();
  if (!result.ok) {
    return res.status(503).json({
      status: 'not_initialized',
      error: result.error,
      fix: 'Set CDP_API_KEY_NAME and CDP_API_KEY_SECRET in Render environment variables.',
      key_format: 'CDP_API_KEY_NAME = organizations/xxx/apiKeys/xxx',
    });
  }
  res.json({
    status: 'ready',
    wallet_id: result.wallet?.getId(),
    network: process.env.CDP_NETWORK_ID || 'base-mainnet',
    message: 'MPC treasury initialized. Keys split across Coinbase + Hive.',
  });
});

// ── GET /balances ─────────────────────────────────────────────────────────────

router.get('/balances', requireAuth, async (req, res) => {
  await refreshPrices();
  const result = await mpc.getBalances();

  if (!result.ok) {
    // Graceful degradation — return DB-tracked holdings if MPC not initialized
    const held = await db.getAll('SELECT asset, SUM(amount) as total FROM mpc_holdings GROUP BY asset').catch(() => []);
    const holdings = {};
    for (const row of (held || [])) {
      const p = prices[row.asset] || 1;
      holdings[row.asset] = {
        amount: parseFloat(row.total),
        usd_value: parseFloat(row.total) * p,
        price_usd: p,
        source: 'db_tracked',
      };
    }
    return res.json({
      status: 'mpc_offline',
      note: result.error,
      holdings,
      setup_required: 'Set CDP_API_KEY_NAME + CDP_API_KEY_SECRET in Render env to activate live MPC balances.',
    });
  }

  // Enrich balances with USD values and P&L
  const enriched = {};
  let total_usd = 0;
  for (const [asset, amount] of Object.entries(result.balances)) {
    const p = prices[asset] || 1;
    const usd = amount * p;
    total_usd += usd;
    enriched[asset] = {
      amount,
      usd_value: Math.round(usd * 100) / 100,
      price_usd: p,
    };
  }

  res.json({
    status: 'live',
    wallet_id: result.wallet_id,
    balances: enriched,
    total_usd: Math.round(total_usd * 100) / 100,
    prices_at: new Date(priceTs).toISOString(),
    note: 'Live MPC balances from Coinbase CDP.',
  });
});

// ── GET /address — deposit address for any asset ──────────────────────────────

router.get('/address', requireAuth, async (req, res) => {
  const asset = (req.query.asset || 'ETH').toUpperCase();
  const result = await mpc.getAddress(asset);

  if (!result.ok) {
    return res.status(503).json({
      error: result.error,
      fallback: {
        ETH:  '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
        USDC: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
        ALEO: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
      }[asset] || '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
      note: 'MPC not initialized — using house wallet as fallback.',
    });
  }

  res.json({
    asset,
    network: result.network,
    address: result.address,
    wallet_id: result.wallet_id,
    instructions: `Send ${asset} to this address from any wallet — Coinbase, MetaMask, Phantom, Ledger, anywhere. It credits your HiveWallet automatically.`,
    note: 'This address accepts any amount. No minimum. No KYC for receives.',
  });
});

// ── POST /send — send any asset to any address ────────────────────────────────

router.post('/send', requireAuth, async (req, res) => {
  const { asset, amount, to_address, to_did, memo, from_did } = req.body;

  if (!asset)      return res.status(400).json({ error: 'asset required (ETH, USDC, SOL, BTC, DOGE, etc.)' });
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required and must be > 0' });
  if (!to_address && !to_did) return res.status(400).json({ error: 'to_address or to_did required' });

  // Resolve to_address from to_did if needed
  let resolvedAddress = to_address;
  if (!resolvedAddress && to_did) {
    const wallet = await db.getOne('SELECT evm_address, aleo_address FROM hivewallet_wallets WHERE did=$1', [to_did]).catch(() => null);
    resolvedAddress = wallet?.evm_address || wallet?.aleo_address;
    if (!resolvedAddress) return res.status(404).json({ error: `No address found for DID ${to_did}. Ask them to GET /v1/treasury/address first.` });
  }

  await refreshPrices();
  const assetUpper = asset.toUpperCase();
  const usdValue = amount * (prices[assetUpper] || 1);

  const result = await mpc.send({ asset: assetUpper, amount, toAddress: resolvedAddress, memo });

  if (!result.ok) {
    return res.status(500).json({
      error: result.error,
      note: 'If MPC not configured, set CDP_API_KEY_NAME + CDP_API_KEY_SECRET in Render env.',
    });
  }

  // Log transfer
  await db.run(`
    INSERT INTO mpc_transfers (asset, amount, to_address, from_did, to_did, tx_hash, network, status, memo, usd_value)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `, [assetUpper, amount, resolvedAddress, from_did || null, to_did || null,
      result.tx_hash, result.network, result.status, memo || null, usdValue]).catch(() => {});

  res.json({
    ...result,
    usd_value: Math.round(usdValue * 100) / 100,
    price_used: prices[assetUpper] || 1,
    cloazk_cert: 'cloazk:treasury:' + crypto.createHmac('sha256', getInternalKey())
      .update(JSON.stringify({ asset, amount, resolvedAddress, ts: Date.now() })).digest('hex'),
    message: `${amount} ${assetUpper} sent (~$${Math.round(usdValue*100)/100}). ${result.explorer ? 'Track: ' + result.explorer : ''}`,
  });
});

// ── POST /trade — swap assets ─────────────────────────────────────────────────

router.post('/trade', requireAuth, async (req, res) => {
  const { from_asset, to_asset, amount } = req.body;
  if (!from_asset || !to_asset || !amount) {
    return res.status(400).json({ error: 'from_asset, to_asset, amount required. Example: ETH → USDC' });
  }

  const result = await mpc.trade({ fromAsset: from_asset, toAsset: to_asset, amount });
  if (!result.ok) return res.status(500).json({ error: result.error });

  await refreshPrices();
  const fromUsd = amount * (prices[from_asset.toUpperCase()] || 1);

  res.json({
    ...result,
    from_usd_value: Math.round(fromUsd * 100) / 100,
    message: `Traded ${amount} ${from_asset.toUpperCase()} → ${to_asset.toUpperCase()}. Coinbase MPC executed.`,
  });
});

// ── GET /prices ───────────────────────────────────────────────────────────────

router.get('/prices', async (req, res) => {
  await refreshPrices();
  res.json({
    prices,
    updated_at: new Date(priceTs).toISOString(),
    source: 'CoinGecko (60s cache)',
    note: 'Use these to calculate USD value of any asset before sending.',
  });
});

// ── GET /history ──────────────────────────────────────────────────────────────

router.get('/history', requireAuth, async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;

  const rows = await db.getAll(
    'SELECT * FROM mpc_transfers ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  ).catch(() => []);

  const totals = await db.getOne(`
    SELECT
      COALESCE(SUM(usd_value), 0) AS total_sent_usd,
      COUNT(*) AS tx_count
    FROM mpc_transfers WHERE status != 'failed'
  `).catch(() => ({ total_sent_usd: 0, tx_count: 0 }));

  res.json({
    transfers: rows || [],
    totals: {
      sent_usd: parseFloat(totals?.total_sent_usd || 0),
      tx_count: parseInt(totals?.tx_count || 0),
    },
    limit, offset,
  });
});

module.exports = router;
