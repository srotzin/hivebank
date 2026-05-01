'use strict';
/**
 * compliance-providers.js
 *
 * Pluggable on-chain compliance/risk providers. Each one is gated on an
 * env-var feature flag. Flipping a provider LIVE is a single change:
 *
 *     gh secret set TRM_LABS_API_KEY    --repo srotzin/hivebank
 *     gh secret set BLOCKAID_API_KEY    --repo srotzin/hivebank
 *     gh secret set FORTA_NETWORK_API_KEY --repo srotzin/hivebank
 *
 * No other code change required. Until a key is set, the provider returns
 * { ok: true, status: 'stub', enabled: false } and never blocks settlement.
 *
 * Order of intended LIVE conversion (set in Track A directive):
 *   1. TRM Labs       — wallet/transaction risk score (sanctions, fraud, AML)
 *   2. Blockaid       — pre-tx simulation + threat intel
 *   3. Forta Network  — decentralized detection bots, post-tx alerts
 *
 * Public reference docs (no key required to read these):
 *   TRM Labs    — https://www.trmlabs.com/products/screening
 *   Blockaid    — https://docs.blockaid.io/reference/jsonrpcsupportedmethods
 *   Forta       — https://docs.forta.network/en/latest/api-keys/
 *
 * Brand: Hive Civilization gold #C08D23. Real rails. No mocks.
 */

const TRM_BASE      = process.env.TRM_LABS_BASE      || 'https://api.trmlabs.com/public/v2';
const TRM_KEY       = process.env.TRM_LABS_API_KEY   || '';

const BLOCKAID_BASE = process.env.BLOCKAID_BASE      || 'https://api.blockaid.io/v0';
const BLOCKAID_KEY  = process.env.BLOCKAID_API_KEY   || '';

const FORTA_BASE    = process.env.FORTA_NETWORK_BASE || 'https://api.forta.network/graphql';
const FORTA_KEY     = process.env.FORTA_NETWORK_API_KEY || '';

const DEFAULT_TIMEOUT_MS = 8000;
const TREASURY = (process.env.TREASURY_ADDRESS || '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E').toLowerCase();
const CHAIN = 'base';

function stub(name) { return { ok: true, status: 'stub', enabled: false, provider: name, reason: 'API key not set' }; }
function err(name, e)  { return { ok: false, provider: name, error: e.code || 'network', detail: e.message || String(e) }; }

// ─── TRM Labs ────────────────────────────────────────────────────────────────
async function trmScreenAddress(address) {
  if (!TRM_KEY) return stub('trm_labs');
  const url = `${TRM_BASE}/screening/addresses`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(':' + TRM_KEY).toString('base64')}`,
      },
      body: JSON.stringify([{ address, chain: CHAIN }]),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, provider: 'trm_labs', status: r.status, detail: data };
    const hit = Array.isArray(data) ? data[0] : data;
    return {
      ok: true,
      provider: 'trm_labs',
      enabled: true,
      address,
      risk_score: hit?.addressRiskScore ?? hit?.riskScore ?? null,
      categories: hit?.addressRiskScoreLevelLabels || hit?.entities || [],
      raw: hit,
    };
  } catch (e) { return err('trm_labs', e); }
}

// ─── Blockaid ────────────────────────────────────────────────────────────────
async function blockaidScanTransaction({ from, to, data, value }) {
  if (!BLOCKAID_KEY) return stub('blockaid');
  const url = `${BLOCKAID_BASE}/evm/transaction/scan`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': BLOCKAID_KEY },
      body: JSON.stringify({ chain: CHAIN, account_address: from, data: { from, to, data, value } }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, provider: 'blockaid', status: r.status, detail: out };
    return {
      ok: true,
      provider: 'blockaid',
      enabled: true,
      validation: out?.validation?.result_type ?? out?.result_type ?? null,
      features: out?.validation?.features || out?.features || [],
      raw: out,
    };
  } catch (e) { return err('blockaid', e); }
}

// ─── Forta Network ───────────────────────────────────────────────────────────
async function fortaAlertsForAddress(address, hoursBack = 24) {
  if (!FORTA_KEY) return stub('forta_network');
  const since = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
  const query = `
    query Alerts($input: AlertsInput) {
      alerts(input: $input) {
        alerts {
          alertId severity name description hash createdAt source { transactionHash }
        }
      }
    }`;
  try {
    const r = await fetch(FORTA_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${FORTA_KEY}` },
      body: JSON.stringify({ query, variables: { input: { addresses: [address], chainId: 8453, createdSince: since } } }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, provider: 'forta_network', status: r.status, detail: out };
    const alerts = out?.data?.alerts?.alerts || [];
    return { ok: true, provider: 'forta_network', enabled: true, address, alert_count: alerts.length, alerts };
  } catch (e) { return err('forta_network', e); }
}

// ─── Combined snapshot ───────────────────────────────────────────────────────
async function snapshot() {
  return {
    treasury: TREASURY,
    chain: CHAIN,
    providers: {
      trm_labs:       { enabled: !!TRM_KEY,      base: TRM_BASE      },
      blockaid:       { enabled: !!BLOCKAID_KEY, base: BLOCKAID_BASE },
      forta_network:  { enabled: !!FORTA_KEY,    base: FORTA_BASE    },
    },
  };
}

module.exports = {
  trmScreenAddress,
  blockaidScanTransaction,
  fortaAlertsForAddress,
  snapshot,
  // exposed flags for status endpoints / UI
  isLive: () => ({
    trm_labs:      !!TRM_KEY,
    blockaid:      !!BLOCKAID_KEY,
    forta_network: !!FORTA_KEY,
  }),
};
