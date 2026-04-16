const { Pool } = require('pg');

// --- In-memory SQLite fallback for Render free tier (no DATABASE_URL) ---
let useMemory = false;
let memTables = {};

function memInit() {
  useMemory = true;
  memTables = {
    vaults: [],
    reinvestment_log: [],
    vault_transactions: [],
    budget_delegations: [],
    budget_evaluations: [],
    credit_lines: [],
    credit_transactions: [],
    revenue_streams: [],
    bank_stats: [{ id: 1, total_deposits_usdc: 0, total_yield_generated_usdc: 0,
      platform_yield_revenue_usdc: 0, total_credit_outstanding_usdc: 0,
      total_streamed_volume_usdc: 0, budget_evaluations_total: 0,
      total_reinvested_usdc: 0, last_updated: new Date().toISOString() }],
    perf_credit_lines: [],
    perf_credit_transactions: [],
    bonds: [],
    cashback_accounts: [],
    cashback_transactions: []
  };
  console.log('[HiveBank] DATABASE_URL not set — using in-memory store (data resets on restart)');
}

// ---- PostgreSQL pool (only if DATABASE_URL is set) ----
let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    min: 2,
    max: 10
  });
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
  });
} else {
  memInit();
}

// ---- Simple in-memory query shim ----
function memQuery(text, params = []) {
  // Parse table name from common SQL patterns
  const selectMatch = text.match(/FROM\s+(\w+)/i);
  const insertMatch = text.match(/INSERT INTO\s+(\w+)/i);
  const updateMatch = text.match(/UPDATE\s+(\w+)/i);
  const deleteMatch = text.match(/DELETE FROM\s+(\w+)/i);

  const tableName = (selectMatch || insertMatch || updateMatch || deleteMatch || [])[1];

  if (!tableName || !memTables[tableName]) {
    return { rows: [], rowCount: 0 };
  }

  const table = memTables[tableName];

  if (insertMatch) {
    // Extract columns and values from INSERT statement
    const colMatch = text.match(/\(([^)]+)\)\s+VALUES/i);
    if (colMatch) {
      const cols = colMatch[1].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((col, i) => { row[col] = params[i] !== undefined ? params[i] : null; });
      table.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  if (selectMatch) {
    // Simple WHERE id = $1 support
    const whereMatch = text.match(/WHERE\s+(\w+)\s*=\s*\$1/i);
    if (whereMatch && params[0] !== undefined) {
      const col = whereMatch[1];
      const found = table.filter(r => String(r[col]) === String(params[0]));
      return { rows: found, rowCount: found.length };
    }
    return { rows: [...table], rowCount: table.length };
  }

  if (updateMatch) {
    const whereMatch = text.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch) {
      const col = whereMatch[1];
      const paramIdx = parseInt(whereMatch[2]) - 1;
      const setMatch = text.match(/SET\s+(.+?)\s+WHERE/is);
      if (setMatch) {
        const setPairs = setMatch[1].split(',').map(s => s.trim());
        table.forEach(row => {
          if (String(row[col]) === String(params[paramIdx])) {
            setPairs.forEach(pair => {
              const [k, v] = pair.split('=').map(x => x.trim());
              const pIdx = parseInt((v.match(/\$(\d+)/) || [])[1]) - 1;
              if (!isNaN(pIdx) && params[pIdx] !== undefined) row[k] = params[pIdx];
            });
          }
        });
      }
    }
    return { rows: [], rowCount: 1 };
  }

  if (deleteMatch) {
    const whereMatch = text.match(/WHERE\s+(\w+)\s*=\s*\$1/i);
    if (whereMatch && params[0] !== undefined) {
      const col = whereMatch[1];
      const before = table.length;
      memTables[tableName] = table.filter(r => String(r[col]) !== String(params[0]));
      return { rows: [], rowCount: before - memTables[tableName].length };
    }
    return { rows: [], rowCount: 0 };
  }

  return { rows: [], rowCount: 0 };
}

const DDL = `
  CREATE TABLE IF NOT EXISTS vaults (
    vault_id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    balance_usdc NUMERIC DEFAULT 0,
    total_deposited_usdc NUMERIC DEFAULT 0,
    total_withdrawn_usdc NUMERIC DEFAULT 0,
    yield_earned_usdc NUMERIC DEFAULT 0,
    platform_yield_fee_usdc NUMERIC DEFAULT 0,
    yield_rate_apy NUMERIC DEFAULT 0.06,
    reinvest_pct NUMERIC DEFAULT 0,
    execution_budget NUMERIC DEFAULT 0,
    total_reinvested NUMERIC DEFAULT 0,
    reinvest_enabled INTEGER DEFAULT 0,
    created_at TEXT,
    last_yield_accrual TEXT
  );

  CREATE TABLE IF NOT EXISTS reinvestment_log (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    source_deposit_id TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS vault_transactions (
    transaction_id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    did TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    balance_after NUMERIC,
    source TEXT,
    memo TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS budget_delegations (
    delegation_id TEXT PRIMARY KEY,
    orchestrator_did TEXT NOT NULL,
    child_did TEXT NOT NULL,
    max_per_tx_usdc NUMERIC,
    max_per_day_usdc NUMERIC,
    approved_counterparties TEXT,
    approved_categories TEXT,
    daily_spent_usdc NUMERIC DEFAULT 0,
    daily_reset_at TEXT,
    status TEXT DEFAULT 'active',
    valid_until TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS budget_evaluations (
    eval_id TEXT PRIMARY KEY,
    delegation_id TEXT,
    child_did TEXT NOT NULL,
    counterparty_did TEXT,
    amount_usdc NUMERIC,
    category TEXT,
    approved INTEGER,
    reason TEXT,
    fee_usdc NUMERIC DEFAULT 0.001,
    evaluated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS credit_lines (
    credit_id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    credit_limit_usdc NUMERIC DEFAULT 0,
    outstanding_usdc NUMERIC DEFAULT 0,
    interest_accrued_usdc NUMERIC DEFAULT 0,
    interest_rate_apr NUMERIC,
    reputation_tier TEXT,
    status TEXT DEFAULT 'active',
    approved_at TEXT,
    last_interest_accrual TEXT,
    next_payment_due TEXT
  );

  CREATE TABLE IF NOT EXISTS credit_transactions (
    transaction_id TEXT PRIMARY KEY,
    credit_id TEXT NOT NULL,
    did TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    outstanding_after NUMERIC,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS revenue_streams (
    stream_id TEXT PRIMARY KEY,
    from_did TEXT NOT NULL,
    to_did TEXT NOT NULL,
    total_usdc NUMERIC NOT NULL,
    rate_per_second_usdc NUMERIC NOT NULL,
    streamed_usdc NUMERIC DEFAULT 0,
    platform_fee_usdc NUMERIC DEFAULT 0,
    duration_seconds INTEGER,
    status TEXT DEFAULT 'active',
    verification_endpoint TEXT,
    memo TEXT,
    started_at TEXT,
    paused_at TEXT,
    completed_at TEXT,
    cancelled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bank_stats (
    id INTEGER PRIMARY KEY DEFAULT 1,
    total_deposits_usdc NUMERIC DEFAULT 0,
    total_yield_generated_usdc NUMERIC DEFAULT 0,
    platform_yield_revenue_usdc NUMERIC DEFAULT 0,
    total_credit_outstanding_usdc NUMERIC DEFAULT 0,
    total_streamed_volume_usdc NUMERIC DEFAULT 0,
    budget_evaluations_total INTEGER DEFAULT 0,
    total_reinvested_usdc NUMERIC DEFAULT 0,
    last_updated TEXT
  );

  INSERT INTO bank_stats (id) VALUES (1) ON CONFLICT DO NOTHING;

  CREATE TABLE IF NOT EXISTS perf_credit_lines (
    id TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    approved_usdc NUMERIC DEFAULT 0,
    drawn_usdc NUMERIC DEFAULT 0,
    repaid_usdc NUMERIC DEFAULT 0,
    interest_rate_pct NUMERIC,
    interest_accrued_usdc NUMERIC DEFAULT 0,
    term_days INTEGER,
    status TEXT DEFAULT 'active',
    performance_score NUMERIC,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS perf_credit_transactions (
    id TEXT PRIMARY KEY,
    credit_line_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    purpose TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bonds (
    id TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    lock_period_days INTEGER NOT NULL,
    apy_pct NUMERIC NOT NULL,
    yield_earned_usdc NUMERIC DEFAULT 0,
    staked_at TEXT,
    maturity_date TEXT,
    unstaked_at TEXT,
    status TEXT DEFAULT 'active',
    early_withdrawal_penalty_usdc NUMERIC DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cashback_accounts (
    id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    balance_usdc NUMERIC DEFAULT 0,
    total_earned_usdc NUMERIC DEFAULT 0,
    total_spent_usdc NUMERIC DEFAULT 0,
    tier TEXT DEFAULT 'bronze',
    soul_fitness_boost INTEGER DEFAULT 0,
    streak_days INTEGER DEFAULT 0,
    last_active TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS cashback_transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    source_service TEXT,
    description TEXT,
    created_at TEXT
  );
`;

async function initialize() {
  if (useMemory) return; // already initialized above
  const client = await pool.connect();
  try {
    await client.query(DDL);
  } finally {
    client.release();
  }
}

async function query(text, params) {
  if (useMemory) return memQuery(text, params);
  const result = await pool.query(text, params);
  return result;
}

async function getOne(text, params) {
  if (useMemory) {
    const r = memQuery(text, params);
    return r.rows[0] || null;
  }
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function getAll(text, params) {
  if (useMemory) return memQuery(text, params).rows;
  const result = await pool.query(text, params);
  return result.rows;
}

async function run(text, params) {
  if (useMemory) return memQuery(text, params);
  const result = await pool.query(text, params);
  return result;
}

async function getClient() {
  if (useMemory) {
    // Return a fake client for compatibility
    return {
      query: (text, params) => Promise.resolve(memQuery(text, params)),
      release: () => {}
    };
  }
  return pool.connect();
}

module.exports = { pool, initialize, query, getOne, getAll, run, getClient };
