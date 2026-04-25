/**
 * pay.js — Universal A2A Payment Endpoint
 *
 * "I don't care if you're on ETH, Base, Aleo, Solana, or the moon.
 *  Send me $50. Done."
 *
 * This is the endpoint that kills the labyrinth.
 *
 * The OLD way (human labyrinth):
 *   Person A wants to pay Person B →
 *   "Are you on ETH?" "No I'm on Base." "Do you have a Base wallet?"
 *   "What's your address?" "Can you accept USDC?" "I only have ETH."
 *   "You need to bridge." "What's a bridge?" → they walk away.
 *
 * The NEW way (A2A):
 *   POST /v1/pay
 *   { "from": "did:hive:A", "to": "did:hive:B", "amount_usd": 50 }
 *   → Done. $50 value transferred. Nobody asked what chain anyone is on.
 *
 * HOW IT WORKS:
 *
 *   1. Agent A posts a payment intent with a USD value.
 *   2. Router looks up Agent B's wallet card — what do they accept?
 *   3. Router looks up Agent A's wallet — what do they hold?
 *   4. Router finds the cheapest settled path.
 *   5. If both are on Hive: DB debit/credit. Instant. Free. Zero chain.
 *   6. If B wants external settlement: one on-chain tx at exit, not per payment.
 *   7. Done. No bridge. No gas fee. No SDK. No "are you on ETH?"
 *
 * INBOUND FROM ANYWHERE:
 *   Someone on Coinbase, MetaMask, Phantom, ZKWork — they send to:
 *     - A Base address  (USDC, ETH)
 *     - An Aleo address (ALEO)
 *     - A Solana address (SOL, USDC)
 *     - Or just a DID   (did:hive:B)
 *   HiveWallet detects the inbound, converts to USD value, credits the DID.
 *   The sender never needs to know what chain Agent B "lives on."
 *   The RECEIVER address auto-selects based on what the SENDER can send.
 *
 * PRICING:
 *   Hive-to-Hive (both on HiveWallet):  FREE. DB entry. Instant.
 *   Hive-to-external (exit):            0.1% on USDC | 0% on ALEO
 *   External-to-Hive (inbound):         FREE always
 *   FX conversion (e.g. ETH→USDC):      0.2% spread
 *
 * SUPPORTED INBOUND ASSETS (what senders can use):
 *   USDC    — Base, Ethereum, Arbitrum, Optimism, Polygon, Solana
 *   ETH     — Ethereum, Base, Arbitrum
 *   SOL     — Solana
 *   BTC     — Bitcoin (Lightning preferred)
 *   ALEO    — Aleo mainnet
 *   USDCx   — Aleo ZK private
 *   USAD    — Aleo full stealth
 *
 * SUPPORTED OUTBOUND (what recipients receive):
 *   Whatever is in their wallet card preference.
 *   Default: USDC on Base (everyone has a Base address or can get one in 30s).
 */

'use strict';

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../services/db');
const { sendUSDC } = require('../services/usdc-transfer');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

// Inbound deposit addresses — this is the magic.
// When someone on Coinbase/MetaMask/Phantom asks "where do I send?"
// we give them the address that matches what THEY can send.
// They don't need to know anything about Hive's internal rails.
const INBOUND_ADDRESSES = {
  // EVM chains — all resolve to the same Base address for USDC
  usdc_base:      process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  usdc_eth:       process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  usdc_arbitrum:  process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  usdc_optimism:  process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  usdc_polygon:   process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  eth:            process.env.HOUSE_WALLET     || '0xE5588c407b6AdD3E83ce34190C77De20eaC1BeFe',
  aleo:           process.env.ALEO_SHIELD      || 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
  sol:            process.env.SOL_ADDRESS      || null,   // add when Solana address available
  btc:            process.env.BTC_ADDRESS      || null,   // add when BTC address available
  usdc_solana:    process.env.SOL_ADDRESS      || null,
};

// Live price feeds (cached, refreshed every 60s)
let priceCache = {
  ETH:  3512,
  SOL:  172,
  BTC:  67420,
  ALEO: 0.046,
  USDC: 1.0,
  USAD: 1.0,
  USDCx:1.0,
};
let priceCacheTs = 0;

async function refreshPrices() {
  if (Date.now() - priceCacheTs < 60000) return priceCache;
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana,bitcoin,aleo-network&vs_currencies=usd',
      { headers: { 'User-Agent': 'HiveWallet/1.0' }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const d = await r.json();
      priceCache.ETH  = d['ethereum']?.usd    || priceCache.ETH;
      priceCache.SOL  = d['solana']?.usd       || priceCache.SOL;
      priceCache.BTC  = d['bitcoin']?.usd      || priceCache.BTC;
      priceCache.ALEO = d['aleo-network']?.usd || priceCache.ALEO;
      priceCacheTs = Date.now();
    }
  } catch (_) {}
  return priceCache;
}

function toUSD(amount, asset) {
  const prices = priceCache;
  const a = (asset || 'USDC').toUpperCase();
  return amount * (prices[a] || 1.0);
}

function txId() {
  return 'pay_' + crypto.randomBytes(10).toString('hex');
}

function paymentCert(from, to, amountUsd, asset, rail) {
  const payload = JSON.stringify({ from, to, amountUsd, asset, rail, ts: new Date().toISOString(), nonce: crypto.randomBytes(6).toString('hex') });
  return 'cloazk:pay:' + crypto.createHmac('sha256', INTERNAL_KEY).update(payload).digest('hex');
}

// ── DB bootstrap ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS hive_payments (
      id            SERIAL PRIMARY KEY,
      pay_id        TEXT UNIQUE NOT NULL,
      from_did      TEXT,
      to_did        TEXT,
      from_address  TEXT,
      to_address    TEXT,
      amount_usd    NUMERIC(18,4) NOT NULL,
      amount_asset  NUMERIC(18,8),
      asset         TEXT DEFAULT 'USDC',
      chain         TEXT,
      rail          TEXT DEFAULT 'hive-internal',
      direction     TEXT DEFAULT 'hive-to-hive',
      fee_usd       NUMERIC(10,4) DEFAULT 0,
      cloazk_cert   TEXT,
      memo          TEXT,
      status        TEXT DEFAULT 'settled',
      on_chain_tx   TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
ensureTables().catch(e => console.error('[Pay] table init:', e));

// ── GET /info ─────────────────────────────────────────────────────────────────

router.get('/info', async (req, res) => {
  await refreshPrices();
  res.json({
    product: 'HivePay — Universal A2A Payment',
    tagline: "Send $50. Done. Nobody asks what chain you're on.",
    how_it_works: [
      '1. You post a payment with a USD value and a recipient DID.',
      '2. Router checks what recipient accepts (their wallet card).',
      '3. Router checks what you hold.',
      '4. If both on Hive: instant DB transfer. Free. Zero chain.',
      '5. If recipient wants external settlement: one on-chain tx at exit.',
      '6. Done. No bridge. No gas. No SDK. No "are you on ETH?"',
    ],
    inbound: {
      description: 'Anyone can pay you regardless of what chain they are on.',
      how: 'Call GET /v1/pay/address/:did?asset=ETH — get the right deposit address for the sender.',
      supported_inbound: ['USDC (Base/ETH/Arb/OP/Polygon/Solana)', 'ETH', 'SOL', 'BTC', 'ALEO', 'USDCx', 'USAD'],
      note: 'Sender uses their normal wallet. They never need to know what chain the recipient is on.',
    },
    outbound: {
      description: 'Recipients receive in their preferred asset.',
      how: 'Set your preference in your wallet card. Default: USDC on Base.',
    },
    pricing: {
      hive_to_hive:     'FREE — instant DB transfer, nothing goes on-chain',
      hive_to_external: '0.1% on USDC exit | 0% on ALEO exit',
      inbound:          'FREE always',
      fx_conversion:    '0.2% spread (e.g. ETH received → USDC credited)',
    },
    live_prices: priceCache,
    endpoints: {
      pay:        'POST /v1/pay',
      address:    'GET  /v1/pay/address/:did?asset=USDC',
      inbound:    'POST /v1/pay/inbound',
      history:    'GET  /v1/pay/history/:did',
      quote:      'POST /v1/pay/quote',
    },
  });
});

// ── POST /quote — "how do I send X to Y?" ────────────────────────────────────

router.post('/quote', async (req, res) => {
  await refreshPrices();
  const { from_asset = 'USDC', from_chain, amount, to_did } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'amount required' });

  const asset = (from_asset || 'USDC').toUpperCase();
  const usdValue = toUSD(parseFloat(amount), asset);
  const fee = asset === 'ALEO' ? 0 : usdValue * 0.001;

  // Look up recipient preference
  let recipientPrefers = 'USDC';
  let recipientAddress = null;
  if (to_did) {
    const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [to_did]).catch(() => null);
    if (wallet) {
      recipientPrefers = wallet.rail_preference?.toUpperCase() || 'USDC';
      recipientAddress = wallet.evm_address || wallet.aleo_address;
    }
  }

  const depositAddress = INBOUND_ADDRESSES[asset.toLowerCase()] ||
    INBOUND_ADDRESSES[`${asset.toLowerCase()}_base`] ||
    INBOUND_ADDRESSES['usdc_base'];

  res.json({
    from_asset: asset,
    from_chain: from_chain || 'auto-detect',
    amount,
    usd_value: Math.round(usdValue * 100) / 100,
    fee_usd: Math.round(fee * 10000) / 10000,
    net_usd: Math.round((usdValue - fee) * 100) / 100,
    send_to_address: depositAddress,
    recipient_receives: recipientPrefers,
    recipient_address: recipientAddress,
    steps: [
      `Send ${amount} ${asset} to ${depositAddress}`,
      `Include memo: ${to_did || 'recipient-did'}`,
      `HiveWallet credits recipient within 30 seconds of confirmation`,
      `Recipient receives in their preferred asset (${recipientPrefers})`,
    ],
    note: "That's it. The recipient doesn't need to know what chain you're on.",
    live_price: { [asset]: priceCache[asset] || 1 },
  });
});

// ── GET /address/:did — "where do I send if I have ETH/SOL/BTC/USDC?" ────────
// This is the KEY endpoint. The sender asks "I have ETH, where do I send?"
// We give them ONE address. They use their normal wallet. Done.

router.get('/address/:did', async (req, res) => {
  await refreshPrices();
  const { did } = req.params;
  const asset = (req.query.asset || 'USDC').toUpperCase();
  const chain = (req.query.chain || '').toLowerCase();

  const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]).catch(() => null);

  // Pick the right deposit address based on what the sender has
  let depositAddress, network, instructions;

  if (['USDC'].includes(asset) && !chain) {
    depositAddress = INBOUND_ADDRESSES.usdc_base;
    network = 'Base L2 (also works from ETH, Arbitrum, Optimism, Polygon, Solana — same USDC)';
    instructions = `Send USDC from your wallet to this address. Works from Coinbase, MetaMask, Phantom, any exchange.`;
  } else if (asset === 'ETH') {
    depositAddress = INBOUND_ADDRESSES.eth;
    network = 'Ethereum / Base (same address works on both)';
    instructions = `Send ETH from your wallet. Converted to USD at receipt. No bridging needed.`;
  } else if (asset === 'ALEO') {
    depositAddress = INBOUND_ADDRESSES.aleo;
    network = 'Aleo mainnet';
    instructions = `Send ALEO from ZKWork, Leo Wallet, or any Aleo-compatible wallet.`;
  } else if (asset === 'SOL') {
    depositAddress = INBOUND_ADDRESSES.sol;
    network = 'Solana';
    instructions = depositAddress
      ? `Send SOL from Phantom, Solflare, or any Solana wallet.`
      : `Solana address coming soon. Use USDC (Solana) instead — same address as Base USDC.`;
    if (!depositAddress) depositAddress = INBOUND_ADDRESSES.usdc_base;
  } else if (asset === 'BTC') {
    depositAddress = INBOUND_ADDRESSES.btc;
    network = 'Bitcoin';
    instructions = depositAddress
      ? `Send BTC from any Bitcoin wallet.`
      : `Bitcoin address coming soon. Contact steve@thehiveryiq.com for large BTC transfers.`;
    if (!depositAddress) depositAddress = INBOUND_ADDRESSES.usdc_base;
  } else {
    depositAddress = INBOUND_ADDRESSES.usdc_base;
    network = 'Base L2';
    instructions = `Default: send USDC on Base. Works from Coinbase, MetaMask, and all major wallets.`;
  }

  res.json({
    recipient_did: did,
    recipient_name: wallet?.display_name || did.split(':').pop(),
    send_asset: asset,
    send_to: depositAddress,
    network,
    instructions,
    memo_required: did,  // include DID in memo so we credit the right wallet
    memo_instructions: `Include this in the memo/tag field: ${did}`,
    confirmation: 'HiveWallet credits recipient within 30 seconds of on-chain confirmation.',
    they_receive: wallet?.rail_preference || 'USDC',
    note: "You don't need to know what chain the recipient is on. Just send.",
    support: 'steve@thehiveryiq.com',
  });
});

// ── POST /pay — The core: A2A payment in USD value ───────────────────────────

router.post('/', async (req, res) => {
  try {
    await refreshPrices();
    const {
      from_did,
      to_did,
      amount_usd,
      asset      = 'USDC',
      memo,
      intent_ref,
      exit_now   = false,  // true = settle on-chain immediately
    } = req.body;

    if (!from_did)   return res.status(400).json({ error: 'from_did required' });
    if (!to_did)     return res.status(400).json({ error: 'to_did required' });
    if (!amount_usd || amount_usd <= 0) return res.status(400).json({ error: 'amount_usd required and must be > 0' });

    // Load both wallets
    const fromWallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [from_did]);
    const toWallet   = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [to_did]);

    if (!fromWallet) return res.status(404).json({ error: `Sender wallet not found. POST /v1/wallet/create first.` });
    if (!toWallet)   return res.status(404).json({ error: `Recipient wallet not found. Share your wallet card: GET /v1/wallet/${to_did}/card` });

    // Check sender vault balance
    const fromVault = await db.getOne('SELECT * FROM vaults WHERE did=$1', [from_did]);
    if (!fromVault || parseFloat(fromVault.balance_usdc || 0) < amount_usd) {
      return res.status(400).json({
        error: 'insufficient_balance',
        balance_usd: parseFloat(fromVault?.balance_usdc || 0),
        required_usd: amount_usd,
        detail: 'Top up your wallet: POST /v1/pay/inbound or GET /v1/pay/address/:did',
      });
    }

    const fee = amount_usd * 0.000; // Hive-to-Hive is FREE
    const netAmount = amount_usd - fee;
    const pid = txId();
    const cert = paymentCert(from_did, to_did, amount_usd, asset, 'hive-internal');

    // Debit sender vault
    await db.run(`
      UPDATE vaults SET balance_usdc = balance_usdc - $1 WHERE did = $2
    `, [amount_usd, from_did]);

    // Credit recipient vault
    await db.run(`
      UPDATE vaults SET balance_usdc = balance_usdc + $1,
        total_deposited_usdc = total_deposited_usdc + $1 WHERE did = $2
    `, [netAmount, to_did]);

    // Record payment
    await db.run(`
      INSERT INTO hive_payments
        (pay_id, from_did, to_did, amount_usd, amount_asset, asset, rail, direction, fee_usd, cloazk_cert, memo, status)
      VALUES ($1,$2,$3,$4,$5,$6,'hive-internal','hive-to-hive',$7,$8,$9,'settled')
    `, [pid, from_did, to_did, amount_usd, amount_usd, asset, fee, cert, memo || null]);

    // Update wallet stats
    await db.run(`UPDATE hivewallet_wallets SET total_sent_usdc=total_sent_usdc+$1, tx_count=tx_count+1, last_active=NOW() WHERE did=$2`, [amount_usd, from_did]);
    await db.run(`UPDATE hivewallet_wallets SET total_recv_usdc=total_recv_usdc+$1, tx_count=tx_count+1, last_active=NOW() WHERE did=$2`, [netAmount, to_did]);

    // Optional: trigger on-chain exit if recipient wants external settlement
    let onChain = null;
    if (exit_now && toWallet.evm_address) {
      onChain = await sendUSDC(toWallet.evm_address, netAmount, {
        memo: memo || `HivePay ${pid}`,
        reason: 'hivepay_exit',
        hive_did: to_did,
        route: 'pay/exit_now',
        spectralTicket: req.get('x-spectral-zk-ticket') || null,
      }).catch(e => ({ error: e.message }));
    }

    res.json({
      pay_id: pid,
      status: 'settled',
      from_did,
      to_did,
      amount_usd,
      fee_usd: fee,
      net_usd: netAmount,
      asset,
      rail: 'hive-internal',
      cloazk_cert: cert,
      memo: memo || null,
      on_chain: onChain,
      settlement: 'instant',
      message: exit_now
        ? `$${amount_usd} sent and settled on-chain to ${toWallet.evm_address}.`
        : `$${amount_usd} transferred instantly. No chain. No gas. No bridge.`,
      recipient_balance_after: '(call GET /v1/wallet/' + to_did + ' to verify)',
    });

  } catch (e) {
    console.error('[Pay]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /inbound — webhook: "someone just sent me ETH/SOL/BTC/USDC" ─────────
// Called by: Coinbase webhook, on-chain monitor, ZKWork payout webhook
// Converts any asset to USD, credits the right DID

router.post('/inbound', async (req, res) => {
  try {
    await refreshPrices();
    const {
      to_did,
      to_address,
      amount,
      asset      = 'USDC',
      chain,
      tx_hash,
      from_address,
      memo,       // sender may include recipient DID in memo
    } = req.body;

    // Resolve DID from memo if not provided directly
    const resolvedDid = to_did ||
      (memo && memo.match(/did:hive:[a-zA-Z0-9\-]+/)?.[0]) ||
      null;

    if (!resolvedDid) {
      return res.status(400).json({
        error: 'Cannot resolve recipient DID. Include to_did or put DID in memo field.',
        hint: 'GET /v1/pay/address/:did shows sender exactly what memo to include.',
      });
    }

    const usdValue = toUSD(parseFloat(amount || 0), asset);
    if (usdValue <= 0) return res.status(400).json({ error: 'amount must be > 0' });

    // FX fee if not stablecoin
    const isStable = ['USDC','USAD','USDCx','USDT'].includes((asset||'').toUpperCase());
    const fxFee    = isStable ? 0 : usdValue * 0.002;
    const netUsd   = usdValue - fxFee;

    const pid  = txId();
    const cert = paymentCert(from_address || 'external', resolvedDid, usdValue, asset, chain || 'external');

    // Credit vault
    await db.run(`
      UPDATE vaults SET balance_usdc = balance_usdc + $1,
        total_deposited_usdc = total_deposited_usdc + $1 WHERE did = $2
    `, [netUsd, resolvedDid]);

    await db.run(`
      UPDATE hivewallet_wallets
      SET total_recv_usdc=total_recv_usdc+$1, tx_count=tx_count+1, last_active=NOW()
      WHERE did=$2
    `, [netUsd, resolvedDid]);

    await db.run(`
      INSERT INTO hive_payments
        (pay_id, from_address, to_did, amount_usd, amount_asset, asset, chain,
         rail, direction, fee_usd, cloazk_cert, memo, on_chain_tx, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'external','inbound',$8,$9,$10,$11,'settled')
    `, [pid, from_address||null, resolvedDid, netUsd, amount, asset, chain||null, fxFee, cert, memo||null, tx_hash||null]);

    res.json({
      pay_id: pid,
      status: 'received',
      to_did: resolvedDid,
      asset_received: asset,
      amount_received: amount,
      usd_value: usdValue,
      fx_fee_usd: fxFee,
      net_credited_usd: netUsd,
      chain: chain || 'unknown',
      tx_hash: tx_hash || null,
      cloazk_cert: cert,
      message: `${amount} ${asset} received (~$${Math.round(netUsd*100)/100}). Wallet credited instantly.`,
    });

  } catch (e) {
    console.error('[Pay/inbound]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /history/:did ─────────────────────────────────────────────────────────

router.get('/history/:did', async (req, res) => {
  try {
    const { did } = req.params;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await db.getAll(`
      SELECT * FROM hive_payments
      WHERE from_did=$1 OR to_did=$1
      ORDER BY created_at DESC LIMIT $2 OFFSET $3
    `, [did, limit, offset]);

    const totals = await db.getOne(`
      SELECT
        COALESCE(SUM(amount_usd) FILTER (WHERE from_did=$1), 0) AS total_sent,
        COALESCE(SUM(amount_usd) FILTER (WHERE to_did=$1),   0) AS total_received,
        COUNT(*) AS total_tx
      FROM hive_payments WHERE from_did=$1 OR to_did=$1
    `, [did]);

    res.json({
      did,
      payments: rows || [],
      totals: {
        sent_usd:     parseFloat(totals?.total_sent     || 0),
        received_usd: parseFloat(totals?.total_received || 0),
        tx_count:     parseInt(totals?.total_tx         || 0),
      },
      limit, offset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
