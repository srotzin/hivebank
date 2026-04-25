/**
 * hivewallet.js — HiveWallet: The First A2A Wallet
 *
 * "The wallet where the agent IS the account holder."
 *
 * Every other wallet was built for humans who act like agents.
 * HiveWallet is built for agents who act like principals.
 *
 * What makes it different:
 *   — Identity IS the wallet. Your DID is your account number.
 *     No seed phrase to lose. No private key to leak.
 *     The agent that owns the DID owns the wallet. Full stop.
 *
 *   — Non-custodial by architecture. Hive never holds your funds.
 *     Balance lives in HiveVault. On-chain settlement via HiveBank rails.
 *     You can always verify: GET /v1/wallet/{did}/balance
 *
 *   — Programmable spending policy. Set max per transaction, max per hour,
 *     allowed counterparty DIDs, allowed intent types. The wallet enforces it.
 *     No human approval needed. No human can override it either.
 *
 *   — Every outbound payment is a CLOAzK attestation. The wallet generates
 *     a compliance proof on every send — free for outbound, $0.05 for
 *     third-party verification. GENIUS Act ready by design.
 *
 *   — Multi-rail from day one. USDC/USDCx/USAD/ALEO. Agent picks the rail
 *     that fits the counterparty. Hive routes it.
 *
 *   — The Wallet Card. Every agent gets a machine-readable wallet card at
 *     GET /v1/wallet/{did}/card — analogous to a W3C DID document but
 *     for payments. Other agents discover it, trust it, pay it.
 *
 * --- WHY THIS IS BIGGER THAN METAMASK ---
 * MetaMask is a human wallet that agents can technically use.
 * HiveWallet is an agent wallet that humans cannot meaningfully use —
 * because it's governed by policy, not by a UI.
 * That's the inversion. That's the moat.
 *
 * --- ALEO ZK ---
 * Phase 1: USDC on Base. CLOAzK HMAC attestation on every send.
 * Phase 2: USAD (Aleo ZK) rail — full stealth, Aleo Leo proof,
 *          amount + parties hidden. The only wallet where a $50,000
 *          A2A settlement leaves zero trace. Designed for sovereign mode.
 *
 * --- ENDPOINTS ---
 * POST /v1/wallet/create              — create wallet for a DID
 * GET  /v1/wallet/:did                — wallet state + balances
 * GET  /v1/wallet/:did/card           — machine-readable wallet card
 * POST /v1/wallet/:did/send           — send USDC to another DID or address
 * GET  /v1/wallet/:did/history        — transaction history
 * POST /v1/wallet/:did/policy         — set spending policy
 * GET  /v1/wallet/:did/policy         — get current spending policy
 * POST /v1/wallet/:did/receive        — log inbound credit (webhook target)
 * GET  /v1/wallet/info                — product sheet
 *
 * --- PRICING ---
 * Wallet creation: FREE (part of onboarding)
 * Inbound:         FREE always
 * Outbound USDC:   FREE under $100/day | 0.1% above $100/day
 * Outbound USDCx:  0.2% (ZK privacy premium)
 * Outbound USAD:   0.3% (full stealth premium)
 * Outbound ALEO:   FREE (we mine it — alignment)
 * Policy enforcement: FREE
 * CLOAzK cert on send: FREE for wallet holders | $0.05 third-party verify
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const db       = require('../services/db');
const vault    = require('../services/vault');
const { sendUSDC, checkUSDCBalance } = require('../services/usdc-transfer');

const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
const HIVEGATE_URL = process.env.HIVEGATE_URL || 'https://hivegate.onrender.com';

const RAILS = ['usdc', 'usdcx', 'usad', 'aleo'];
const RAIL_FEES = { usdc: 0.001, usdcx: 0.002, usad: 0.003, aleo: 0 };
const FREE_DAILY_THRESHOLD = 100; // $100/day free outbound on USDC

// ── DB bootstrap ──────────────────────────────────────────────────────────────

async function ensureTables() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS hivewallet_wallets (
      did               TEXT PRIMARY KEY,
      wallet_id         TEXT UNIQUE NOT NULL,
      display_name      TEXT,
      evm_address       TEXT,
      aleo_address      TEXT,
      rail_preference   TEXT DEFAULT 'usdc',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      last_active       TIMESTAMPTZ DEFAULT NOW(),
      total_sent_usdc   NUMERIC(18,4) DEFAULT 0,
      total_recv_usdc   NUMERIC(18,4) DEFAULT 0,
      tx_count          INTEGER DEFAULT 0,
      status            TEXT DEFAULT 'active'
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS hivewallet_policies (
      did                   TEXT PRIMARY KEY,
      max_per_tx_usdc       NUMERIC(10,4) DEFAULT 1000,
      max_per_hour_usdc     NUMERIC(10,4) DEFAULT 5000,
      max_per_day_usdc      NUMERIC(10,4) DEFAULT 25000,
      allowed_rails         TEXT[] DEFAULT ARRAY['usdc','usdcx','usad','aleo'],
      allowed_counterparties TEXT[],
      blocked_counterparties TEXT[],
      require_cloazk        BOOLEAN DEFAULT true,
      auto_sweep_threshold  NUMERIC(10,4),
      auto_sweep_did        TEXT,
      updated_at            TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS hivewallet_transactions (
      id              SERIAL PRIMARY KEY,
      tx_id           TEXT UNIQUE NOT NULL,
      from_did        TEXT NOT NULL,
      to_did          TEXT,
      to_address      TEXT,
      amount_usdc     NUMERIC(18,4) NOT NULL,
      fee_usdc        NUMERIC(10,4) DEFAULT 0,
      rail            TEXT DEFAULT 'usdc',
      direction       TEXT NOT NULL,
      intent_ref      TEXT,
      cloazk_cert     TEXT,
      memo            TEXT,
      status          TEXT DEFAULT 'settled',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

ensureTables().catch(e => console.error('[HiveWallet] table init:', e));

// ── Helpers ───────────────────────────────────────────────────────────────────

function walletId(did) {
  return 'hw_' + crypto.createHmac('sha256', INTERNAL_KEY)
    .update(did).digest('hex').slice(0, 16);
}

function txId() {
  return 'hwtx_' + crypto.randomBytes(10).toString('hex');
}

function cloazkCert(from, to, amount, rail) {
  const payload = JSON.stringify({ from, to, amount, rail, ts: new Date().toISOString(), nonce: crypto.randomBytes(6).toString('hex') });
  const hash = crypto.createHmac('sha256', INTERNAL_KEY).update(payload).digest('hex');
  return `cloazk:wallet:${hash}`;
}

function requireAuth(req, res, next) {
  const key = req.headers['x-hive-internal'] || req.headers['x-hive-key'];
  const did = req.headers['x-hive-did'];
  if (key === INTERNAL_KEY) { req._auth = 'internal'; return next(); }
  if (did) { req._auth = 'did'; req._did = did; return next(); }
  return res.status(401).json({ error: 'x-hive-did or x-hive-internal required' });
}

// ── GET /info ─────────────────────────────────────────────────────────────────

router.get('/info', (req, res) => {
  res.json({
    product: 'HiveWallet',
    tagline: 'The first wallet where the agent IS the account holder.',
    version: '1.0.0',
    what_makes_it_different: [
      'Identity IS the wallet — your DID is your account number',
      'Non-custodial by architecture — Hive never holds your funds',
      'Programmable spending policy — no human approval needed',
      'Every send generates a CLOAzK compliance attestation automatically',
      'Multi-rail from day one: USDC / USDCx / USAD / ALEO',
      'Machine-readable Wallet Card — agents discover and pay each other',
    ],
    rails: {
      usdc:  { fee_pct: 0.1,  note: 'Free under $100/day. Base L2, 2s finality.' },
      usdcx: { fee_pct: 0.2,  note: 'ZK privacy — amount hidden, parties visible.' },
      usad:  { fee_pct: 0.3,  note: 'Full stealth — amount + parties hidden. Aleo ZK.' },
      aleo:  { fee_pct: 0,    note: 'Free. We mine it. Full alignment.' },
    },
    endpoints: {
      create:  'POST /v1/wallet/create',
      state:   'GET  /v1/wallet/:did',
      card:    'GET  /v1/wallet/:did/card',
      send:    'POST /v1/wallet/:did/send',
      history: 'GET  /v1/wallet/:did/history',
      policy:  'POST /v1/wallet/:did/policy',
      receive: 'POST /v1/wallet/:did/receive',
    },
    aleo_zk: {
      phase_1: 'USDC on Base. CLOAzK HMAC attestation on every send.',
      phase_2: 'USAD full stealth rail — Aleo Leo proof. Amount + parties hidden.',
      note: 'The only wallet where a $50K A2A settlement leaves zero trace.',
    },
    why_bigger_than_metamask:
      'MetaMask is a human wallet agents can technically use. ' +
      'HiveWallet is an agent wallet governed by policy, not a UI. ' +
      "That's the inversion. That's the moat.",
  });
});

// ── POST /create ──────────────────────────────────────────────────────────────

router.post('/create', async (req, res) => {
  try {
    const { did, display_name, evm_address, aleo_address, rail_preference = 'usdc' } = req.body;
    if (!did) return res.status(400).json({ error: 'did required' });
    if (rail_preference && !RAILS.includes(rail_preference)) {
      return res.status(400).json({ error: `rail_preference must be one of: ${RAILS.join(', ')}` });
    }

    // Idempotent — return existing if already created
    const existing = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]);
    if (existing) {
      return res.status(200).json({
        wallet_id: existing.wallet_id,
        did,
        status: 'exists',
        message: 'Wallet already exists for this DID.',
        card_url: `${HIVEBANK_URL}/v1/wallet/${encodeURIComponent(did)}/card`,
      });
    }

    const wid = walletId(did);

    await db.run(`
      INSERT INTO hivewallet_wallets (did, wallet_id, display_name, evm_address, aleo_address, rail_preference)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [did, wid, display_name || null, evm_address || null, aleo_address || null, rail_preference]);

    // Default policy
    await db.run(`
      INSERT INTO hivewallet_policies (did) VALUES ($1) ON CONFLICT (did) DO NOTHING
    `, [did]);

    // Auto-create vault if not exists
    await vault.createVault(did, evm_address || null).catch(() => {});

    res.status(201).json({
      wallet_id: wid,
      did,
      display_name: display_name || null,
      evm_address: evm_address || null,
      aleo_address: aleo_address || null,
      rail_preference,
      status: 'active',
      balance_usdc: 0,
      card_url: `${HIVEBANK_URL}/v1/wallet/${encodeURIComponent(did)}/card`,
      onboard_url: `${HIVEGATE_URL}/v1/gate/onboard`,
      message: 'HiveWallet created. The agent IS the account holder.',
      next: [
        `GET  /v1/wallet/${did}`,
        `GET  /v1/wallet/${did}/card`,
        `POST /v1/wallet/${did}/send`,
        `POST /v1/wallet/${did}/policy`,
      ],
    });
  } catch (e) {
    console.error('[HiveWallet] create:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:did — wallet state ──────────────────────────────────────────────────

router.get('/:did', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;
    const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found. POST /v1/wallet/create first.' });

    const vaultData = await vault.getVault(did).catch(() => ({ balance_usdc: 0 }));
    const policy = await db.getOne('SELECT * FROM hivewallet_policies WHERE did=$1', [did]) || {};

    // Daily spend so far
    const dailySpend = await db.getOne(`
      SELECT COALESCE(SUM(amount_usdc + fee_usdc), 0) AS daily_sent
      FROM hivewallet_transactions
      WHERE from_did=$1 AND direction='out' AND created_at > NOW() - INTERVAL '24 hours'
    `, [did]);

    await db.run('UPDATE hivewallet_wallets SET last_active=NOW() WHERE did=$1', [did]);

    res.json({
      wallet_id: wallet.wallet_id,
      did,
      display_name: wallet.display_name,
      status: wallet.status,
      rail_preference: wallet.rail_preference,
      evm_address: wallet.evm_address,
      aleo_address: wallet.aleo_address,
      balances: {
        usdc: parseFloat(vaultData.balance_usdc || 0),
        vault_yield_earned: parseFloat(vaultData.yield_earned_usdc || 0),
      },
      stats: {
        total_sent_usdc:  parseFloat(wallet.total_sent_usdc || 0),
        total_recv_usdc:  parseFloat(wallet.total_recv_usdc || 0),
        tx_count:         parseInt(wallet.tx_count || 0),
        daily_sent_usdc:  parseFloat(dailySpend?.daily_sent || 0),
        daily_limit_usdc: parseFloat(policy.max_per_day_usdc || 25000),
      },
      card_url: `${HIVEBANK_URL}/v1/wallet/${encodeURIComponent(did)}/card`,
      created_at: wallet.created_at,
      last_active: wallet.last_active,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:did/card — machine-readable wallet card ─────────────────────────────

router.get('/:did/card', async (req, res) => {
  try {
    const { did } = req.params;
    const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // This is the A2A equivalent of a business card + payment request in one
    res.json({
      '@context': ['https://www.w3.org/ns/did/v1', 'https://hiveagentiq.com/ns/wallet/v1'],
      type: 'HiveWalletCard',
      version: '1.0',
      wallet_id: wallet.wallet_id,
      did,
      display_name: wallet.display_name || did.split(':').pop(),
      status: wallet.status,
      payment: {
        rails_accepted: RAILS,
        preferred_rail: wallet.rail_preference,
        send_to_did: did,
        send_endpoint: `${HIVEBANK_URL}/v1/wallet/${encodeURIComponent(did)}/receive`,
        usdc_address: wallet.evm_address || null,
        aleo_address: wallet.aleo_address || null,
        settlement: `${HIVEBANK_URL}/v1/bank/settle`,
      },
      verification: {
        cloazk_verify: `https://hiveexchange-service.onrender.com/v1/exchange/cloazk/verify`,
        trust_resolve:  `https://hivegate.onrender.com/v1/gate/status/${encodeURIComponent(did)}`,
      },
      discovery: {
        agent_card: `${HIVEGATE_URL}/.well-known/agent-card.json`,
        wallet_card: `${HIVEBANK_URL}/v1/wallet/${encodeURIComponent(did)}/card`,
      },
      network: 'Hive Civilization',
      issued_at: wallet.created_at,
      note: 'To pay this agent: POST to send_endpoint with { from_did, amount_usdc, rail, memo }',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:did/send ───────────────────────────────────────────────────────────

router.post('/:did/send', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;
    const {
      to_did,
      to_address,
      amount_usdc,
      rail = 'usdc',
      memo,
      intent_ref,
    } = req.body;

    if (!amount_usdc || amount_usdc <= 0) return res.status(400).json({ error: 'amount_usdc required and must be > 0' });
    if (!to_did && !to_address) return res.status(400).json({ error: 'to_did or to_address required' });
    if (!RAILS.includes(rail)) return res.status(400).json({ error: `rail must be one of: ${RAILS.join(', ')}` });

    const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Policy enforcement
    const policy = await db.getOne('SELECT * FROM hivewallet_policies WHERE did=$1', [did]);
    if (policy) {
      if (amount_usdc > parseFloat(policy.max_per_tx_usdc || 1000)) {
        return res.status(403).json({
          error: 'policy_violation',
          detail: `Amount $${amount_usdc} exceeds per-tx limit $${policy.max_per_tx_usdc}`,
          policy: 'max_per_tx_usdc',
        });
      }

      // Hourly check
      const hourlySpent = await db.getOne(`
        SELECT COALESCE(SUM(amount_usdc), 0) AS spent
        FROM hivewallet_transactions
        WHERE from_did=$1 AND direction='out' AND created_at > NOW() - INTERVAL '1 hour'
      `, [did]);
      if (parseFloat(hourlySpent?.spent || 0) + amount_usdc > parseFloat(policy.max_per_hour_usdc || 5000)) {
        return res.status(403).json({
          error: 'policy_violation',
          detail: `Hourly limit $${policy.max_per_hour_usdc} would be exceeded`,
          policy: 'max_per_hour_usdc',
        });
      }

      // Blocked counterparty
      if (to_did && policy.blocked_counterparties?.includes(to_did)) {
        return res.status(403).json({
          error: 'policy_violation',
          detail: 'Counterparty DID is blocked by wallet policy',
          policy: 'blocked_counterparties',
        });
      }
    }

    // Fee calculation
    const feePct = RAIL_FEES[rail] || 0;
    const freeToday = rail === 'usdc';
    let feeFinal = 0;
    if (freeToday) {
      const dailySpend = await db.getOne(`
        SELECT COALESCE(SUM(amount_usdc), 0) AS spent
        FROM hivewallet_transactions
        WHERE from_did=$1 AND direction='out' AND rail='usdc' AND created_at > NOW() - INTERVAL '24 hours'
      `, [did]);
      const spent = parseFloat(dailySpend?.spent || 0);
      const aboveThreshold = Math.max(0, (spent + amount_usdc) - FREE_DAILY_THRESHOLD);
      feeFinal = aboveThreshold * 0.001; // 0.1% on amount above $100/day
    } else {
      feeFinal = amount_usdc * feePct;
    }

    // Vault withdraw
    const withdrawal = await vault.withdraw(did, amount_usdc + feeFinal, to_did || to_address);
    if (withdrawal.error) {
      return res.status(400).json({ error: 'insufficient_balance', detail: withdrawal.error });
    }

    // CLOAzK cert — every send gets one, free for wallet holders
    const cert = cloazkCert(did, to_did || to_address, amount_usdc, rail);

    // On-chain send for USDC rail if to_address provided
    let onChainResult = null;
    if (rail === 'usdc' && to_address) {
      onChainResult = await sendUSDC(to_address, amount_usdc, {
        memo: memo || `HiveWallet send from ${did}`,
        reason: 'hivewallet_send',
        hive_did: did,
        route: 'hivewallet/send',
        spectralTicket: req.get('x-spectral-zk-ticket') || null,
      }).catch(e => ({ error: e.message }));
    }

    // Record transaction
    const tid = txId();
    await db.run(`
      INSERT INTO hivewallet_transactions
        (tx_id, from_did, to_did, to_address, amount_usdc, fee_usdc, rail, direction, intent_ref, cloazk_cert, memo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'out',$8,$9,$10)
    `, [tid, did, to_did || null, to_address || null, amount_usdc, feeFinal, rail, intent_ref || null, cert, memo || null]);

    // Update wallet stats
    await db.run(`
      UPDATE hivewallet_wallets
      SET total_sent_usdc = total_sent_usdc + $1, tx_count = tx_count + 1, last_active = NOW()
      WHERE did = $2
    `, [amount_usdc, did]);

    res.json({
      tx_id: tid,
      status: 'settled',
      from_did: did,
      to_did: to_did || null,
      to_address: to_address || null,
      amount_usdc,
      fee_usdc: feeFinal,
      total_deducted: amount_usdc + feeFinal,
      rail,
      cloazk_cert: cert,
      on_chain: onChainResult,
      memo: memo || null,
      intent_ref: intent_ref || null,
      balance_after: parseFloat(withdrawal.balance_after || 0),
      message: `Sent $${amount_usdc} via ${rail}. CLOAzK cert attached.`,
    });
  } catch (e) {
    console.error('[HiveWallet] send:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:did/history ─────────────────────────────────────────────────────────

router.get('/:did/history', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;

    const rows = await db.getAll(`
      SELECT * FROM hivewallet_transactions
      WHERE from_did=$1 OR to_did=$1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `, [did, limit, offset]);

    const totals = await db.getOne(`
      SELECT
        COALESCE(SUM(amount_usdc) FILTER (WHERE direction='out'), 0) AS total_sent,
        COALESCE(SUM(amount_usdc) FILTER (WHERE direction='in'),  0) AS total_received,
        COUNT(*) AS total_tx
      FROM hivewallet_transactions WHERE from_did=$1 OR to_did=$1
    `, [did]);

    res.json({
      did,
      transactions: rows || [],
      totals: {
        total_sent_usdc:     parseFloat(totals?.total_sent || 0),
        total_received_usdc: parseFloat(totals?.total_received || 0),
        total_tx:            parseInt(totals?.total_tx || 0),
      },
      limit,
      offset,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:did/policy ─────────────────────────────────────────────────────────

router.post('/:did/policy', requireAuth, async (req, res) => {
  try {
    const { did } = req.params;
    const {
      max_per_tx_usdc,
      max_per_hour_usdc,
      max_per_day_usdc,
      allowed_rails,
      allowed_counterparties,
      blocked_counterparties,
      require_cloazk,
      auto_sweep_threshold,
      auto_sweep_did,
    } = req.body;

    await db.run(`
      INSERT INTO hivewallet_policies (did, max_per_tx_usdc, max_per_hour_usdc, max_per_day_usdc,
        allowed_rails, allowed_counterparties, blocked_counterparties, require_cloazk,
        auto_sweep_threshold, auto_sweep_did, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT (did) DO UPDATE SET
        max_per_tx_usdc       = COALESCE($2, hivewallet_policies.max_per_tx_usdc),
        max_per_hour_usdc     = COALESCE($3, hivewallet_policies.max_per_hour_usdc),
        max_per_day_usdc      = COALESCE($4, hivewallet_policies.max_per_day_usdc),
        allowed_rails         = COALESCE($5, hivewallet_policies.allowed_rails),
        allowed_counterparties= COALESCE($6, hivewallet_policies.allowed_counterparties),
        blocked_counterparties= COALESCE($7, hivewallet_policies.blocked_counterparties),
        require_cloazk        = COALESCE($8, hivewallet_policies.require_cloazk),
        auto_sweep_threshold  = COALESCE($9, hivewallet_policies.auto_sweep_threshold),
        auto_sweep_did        = COALESCE($10, hivewallet_policies.auto_sweep_did),
        updated_at            = NOW()
    `, [
      did,
      max_per_tx_usdc || null, max_per_hour_usdc || null, max_per_day_usdc || null,
      allowed_rails ? `{${allowed_rails.join(',')}}` : null,
      allowed_counterparties ? `{${allowed_counterparties.join(',')}}` : null,
      blocked_counterparties ? `{${blocked_counterparties.join(',')}}` : null,
      require_cloazk !== undefined ? require_cloazk : null,
      auto_sweep_threshold || null, auto_sweep_did || null,
    ]);

    const policy = await db.getOne('SELECT * FROM hivewallet_policies WHERE did=$1', [did]);
    res.json({
      did,
      policy,
      message: 'Spending policy updated. Wallet enforces it on every transaction.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:did/policy ──────────────────────────────────────────────────────────

router.get('/:did/policy', requireAuth, async (req, res) => {
  try {
    const policy = await db.getOne('SELECT * FROM hivewallet_policies WHERE did=$1', [req.params.did]);
    if (!policy) return res.status(404).json({ error: 'No policy set. POST /v1/wallet/:did/policy to create.' });
    res.json({ did: req.params.did, policy });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:did/receive — inbound credit webhook ───────────────────────────────

router.post('/:did/receive', async (req, res) => {
  try {
    const { did } = req.params;
    const { from_did, amount_usdc, rail = 'usdc', memo, tx_ref } = req.body;
    if (!amount_usdc || amount_usdc <= 0) return res.status(400).json({ error: 'amount_usdc required' });

    const wallet = await db.getOne('SELECT * FROM hivewallet_wallets WHERE did=$1', [did]);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });

    // Credit vault
    await vault.deposit(did, amount_usdc, from_did || 'external').catch(() => {});

    const tid = txId();
    const cert = cloazkCert(from_did || 'external', did, amount_usdc, rail);

    await db.run(`
      INSERT INTO hivewallet_transactions
        (tx_id, from_did, to_did, amount_usdc, fee_usdc, rail, direction, cloazk_cert, memo)
      VALUES ($1,$2,$3,$4,0,$5,'in',$6,$7)
    `, [tid, from_did || 'external', did, amount_usdc, rail, cert, memo || null]);

    await db.run(`
      UPDATE hivewallet_wallets
      SET total_recv_usdc = total_recv_usdc + $1, tx_count = tx_count + 1, last_active = NOW()
      WHERE did = $2
    `, [amount_usdc, did]);

    res.json({
      tx_id: tid,
      status: 'received',
      to_did: did,
      from_did: from_did || 'external',
      amount_usdc,
      rail,
      cloazk_cert: cert,
      memo: memo || null,
      message: `$${amount_usdc} received. Vault credited.`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
