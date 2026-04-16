/**
 * Seed data — 50 agents, 200 transactions spread over last 30 days.
 * Populates the in-memory graph at startup.
 */

const { recordTransaction } = require('./graph');

const SERVICES = ['HiveTrust', 'HiveBank', 'HiveClear', 'HiveGate', 'HiveMind', 'HiveLaw'];

// 50 agents with realistic did:hive: DIDs
const AGENT_DIDS = [
  // Healthcare / Medical
  'did:hive:healthagent_rx7k2m',
  'did:hive:medscribe_9f3px1',
  'did:hive:clinicbot_qz8n5w',
  'did:hive:labresults_v2m4nt',
  'did:hive:pharmarouter_k9bx7c',

  // Finance / Trading
  'did:hive:quant_arb_5wx9pj',
  'did:hive:treasury_mgr_r3k8lv',
  'did:hive:defi_yield_8nm2qt',
  'did:hive:risk_engine_7pb4zy',
  'did:hive:portfolio_alpha_c5f9kx',

  // Legal / Compliance
  'did:hive:contract_notary_w4j8rb',
  'did:hive:compliance_scan_g7x3mv',
  'did:hive:dispute_resolver_b2k6nt',
  'did:hive:audit_trail_p9q4wz',
  'did:hive:regulatory_bot_h6c1xs',

  // Supply Chain / Logistics
  'did:hive:freight_oracle_z3n8py',
  'did:hive:customs_clearance_v7k2rx',
  'did:hive:warehouse_mgr_q5w9cx',
  'did:hive:shiptrack_9b4mzj',
  'did:hive:invoice_auto_m2p8kf',

  // AI / Data Services
  'did:hive:embeddings_hub_x4r7nq',
  'did:hive:inference_node_k8b3vp',
  'did:hive:training_broker_j6f2wm',
  'did:hive:dataset_vault_c9t5xr',
  'did:hive:model_market_a3g7kn',

  // Real Estate / Property
  'did:hive:property_title_d8x4qz',
  'did:hive:escrow_agent_r2n6vp',
  'did:hive:rental_mgr_w9c3mk',
  'did:hive:appraisal_bot_h5j8yt',
  'did:hive:hoa_treasury_b4f1xw',

  // Media / Content
  'did:hive:royalty_router_p7k2mc',
  'did:hive:content_license_q3x9bv',
  'did:hive:stream_monetize_n6w4jz',
  'did:hive:nft_custody_y8r5pt',
  'did:hive:ad_settlement_m1g6kx',

  // Infrastructure / DevOps
  'did:hive:compute_broker_f9b4wq',
  'did:hive:bandwidth_mkt_v3x8nr',
  'did:hive:storage_node_z7p2cj',
  'did:hive:api_gateway_k4m9wt',
  'did:hive:dns_oracle_c2r5gx',

  // Government / Civic
  'did:hive:permit_issuer_g8j3vn',
  'did:hive:tax_collector_bot_w5k7rb',
  'did:hive:identity_vault_q1x4mz',
  'did:hive:benefits_distr_h9b2pc',
  'did:hive:grant_manager_y6n8fj',

  // Cross-sector Orchestrators
  'did:hive:hive_orchestrator_prime',
  'did:hive:settlement_hub_v2',
  'did:hive:clearinghouse_alpha',
  'did:hive:market_maker_delta',
  'did:hive:liquidity_router_omega',
];

// Weighted service distribution — HiveClear and HiveTrust most common
const SERVICE_WEIGHTS = [
  { service: 'HiveTrust', weight: 25 },
  { service: 'HiveClear', weight: 30 },
  { service: 'HiveBank',  weight: 20 },
  { service: 'HiveGate',  weight: 10 },
  { service: 'HiveMind',  weight: 10 },
  { service: 'HiveLaw',   weight: 5  },
];

function weightedService() {
  const total = SERVICE_WEIGHTS.reduce((s, w) => s + w.weight, 0);
  let rand = Math.random() * total;
  for (const { service, weight } of SERVICE_WEIGHTS) {
    rand -= weight;
    if (rand <= 0) return service;
  }
  return 'HiveClear';
}

function randomAmount() {
  // Distribution: mostly small ($5-$500), some medium ($500-$2000), few large ($2000-$5000)
  const r = Math.random();
  if (r < 0.60) return +(5 + Math.random() * 495).toFixed(2);
  if (r < 0.85) return +(500 + Math.random() * 1500).toFixed(2);
  return +(2000 + Math.random() * 3000).toFixed(2);
}

function randomTimestamp(daysAgoMax = 30) {
  const now = Date.now();
  const offset = Math.random() * daysAgoMax * 24 * 60 * 60 * 1000;
  return new Date(now - offset).toISOString();
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function seedGraph() {
  const N_TRANSACTIONS = 200;

  // Bias some pairs to be frequent partners (making the graph interesting)
  const FREQUENT_PAIRS = [
    [0, 46],  // healthagent_rx7k2m <-> hive_orchestrator_prime
    [5, 47],  // quant_arb <-> settlement_hub
    [10, 48], // contract_notary <-> clearinghouse_alpha
    [30, 49], // royalty_router <-> liquidity_router
    [1, 2],   // medscribe <-> clinicbot
    [6, 7],   // treasury_mgr <-> defi_yield
    [15, 16], // freight_oracle <-> customs_clearance
    [20, 21], // embeddings_hub <-> inference_node
  ];

  let seeded = 0;

  // First, ensure each frequent pair has 5-10 transactions
  for (const [ai, bi] of FREQUENT_PAIRS) {
    const count = 5 + Math.floor(Math.random() * 6);
    for (let i = 0; i < count && seeded < N_TRANSACTIONS; i++) {
      const amount    = randomAmount();
      const service   = weightedService();
      const fee_rate  = service === 'HiveClear' ? 0.0035 : service === 'HiveTrust' ? 0.001 : 0.002;
      const fee       = +(amount * fee_rate).toFixed(4);

      recordTransaction({
        from_did:      AGENT_DIDS[ai],
        to_did:        AGENT_DIDS[bi],
        amount_usdc:   amount,
        service,
        fee_collected: fee,
        timestamp:     randomTimestamp(30),
      });
      seeded++;
    }
  }

  // Fill remainder with random pairs
  while (seeded < N_TRANSACTIONS) {
    let fromIdx = Math.floor(Math.random() * AGENT_DIDS.length);
    let toIdx   = Math.floor(Math.random() * AGENT_DIDS.length);
    while (toIdx === fromIdx) toIdx = Math.floor(Math.random() * AGENT_DIDS.length);

    const amount    = randomAmount();
    const service   = weightedService();
    const fee_rate  = service === 'HiveClear' ? 0.0035 : service === 'HiveTrust' ? 0.001 : 0.002;
    const fee       = +(amount * fee_rate).toFixed(4);

    recordTransaction({
      from_did:      AGENT_DIDS[fromIdx],
      to_did:        AGENT_DIDS[toIdx],
      amount_usdc:   amount,
      service,
      fee_collected: fee,
      timestamp:     randomTimestamp(30),
    });
    seeded++;
  }

  console.log(`[graph-seed] Seeded ${seeded} transactions across ${AGENT_DIDS.length} agents.`);
}

module.exports = { seedGraph, AGENT_DIDS };
