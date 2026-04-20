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
    cashback_transactions: [],
    referrals: [],
    usdc_sends: [],
    rewards: []
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

// ---- In-memory query shim — handles SELECT (incl. aggregates), INSERT, UPDATE, DELETE ----
function memQuery(text, params = []) {
  const t = text.trim();

  // Transaction control — no-ops in memory
  if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(t)) return { rows: [], rowCount: 0 };

  // Parse table name from common SQL patterns
  const selectMatch = t.match(/FROM\s+(\w+)/i);
  const insertMatch = t.match(/INSERT INTO\s+(\w+)/i);
  const updateMatch = t.match(/UPDATE\s+(\w+)/i);
  const deleteMatch = t.match(/DELETE FROM\s+(\w+)/i);

  const tableName = (selectMatch || insertMatch || updateMatch || deleteMatch || [])[1];

  if (!tableName || !memTables[tableName]) {
    // Aggregate on unknown/empty table — return zeros
    if (selectMatch && /COUNT|SUM|AVG|MAX|MIN/i.test(t)) {
      return { rows: [{ cnt: 0, total: 0, c: 0, t: 0 }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  const table = memTables[tableName];

  // ── INSERT ──────────────────────────────────────────────────────────────────
  if (insertMatch) {
    const colMatch = t.match(/\(([^)]+)\)\s+VALUES/i);
    if (colMatch) {
      const cols = colMatch[1].split(',').map(c => c.trim());
      const row = {};
      cols.forEach((col, i) => { row[col] = params[i] !== undefined ? params[i] : null; });
      // Auto-increment SERIAL id for usdc_sends and rewards
      if ((tableName === 'usdc_sends' || tableName === 'rewards') && row.id === null) {
        const maxId = table.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
        row.id = maxId + 1;
      }
      // ON CONFLICT DO NOTHING — skip if primary key exists
      if (/ON CONFLICT DO NOTHING/i.test(t)) {
        const pkMatch = t.match(/INSERT INTO\s+\w+\s*\(([^)]+)\)/i);
        if (pkMatch) {
          const firstCol = pkMatch[1].split(',')[0].trim();
          if (table.some(r => r[firstCol] === row[firstCol])) return { rows: [], rowCount: 0 };
        }
      }
      // UNIQUE(did, trigger) conflict for rewards table
      if (tableName === 'rewards' && /ON CONFLICT.*DO NOTHING/i.test(t)) {
        if (table.some(r => r.did === row.did && r.trigger === row.trigger)) {
          return { rows: [], rowCount: 0 };
        }
      }
      table.push(row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // ── SELECT ──────────────────────────────────────────────────────────────────
  if (selectMatch) {
    // Filter rows by WHERE clause — supports multiple AND conditions
    let rows = [...table];
    // Extract all WHERE conditions of the form col = $N
    const whereSection = t.match(/WHERE\s+(.+?)(?:ORDER BY|LIMIT|$)/is);
    if (whereSection) {
      const conditions = [...whereSection[1].matchAll(/(\w+)\s*=\s*\$(\d+)/gi)];
      for (const cond of conditions) {
        const col = cond[1];
        const val = params[parseInt(cond[2]) - 1];
        if (val !== undefined) {
          rows = rows.filter(r => String(r[col]) === String(val));
        }
      }
    }

    // Aggregate functions — COUNT(*), SUM(col), COALESCE(SUM(col), 0)
    if (/COUNT\s*\(|SUM\s*\(|AVG\s*\(|MAX\s*\(|MIN\s*\(/i.test(t)) {
      const aggRow = {};
      // COUNT(*) as X
      const countAs = t.match(/COUNT\s*\(\*\)\s+as\s+(\w+)/i);
      if (countAs) aggRow[countAs[1]] = rows.length;
      // COALESCE(SUM(col), 0) as X  or  SUM(col) as X
      const sumMatches = [...t.matchAll(/(?:COALESCE\s*\(\s*)?SUM\s*\((\w+)\)(?:\s*,\s*[^)]+\))?\s+as\s+(\w+)/gi)];
      sumMatches.forEach(m => {
        const col = m[1], alias = m[2];
        aggRow[alias] = rows.reduce((acc, r) => acc + (parseFloat(r[col]) || 0), 0);
      });
      // COUNT(*) with no alias — return as c
      if (!countAs && /COUNT\s*\(\*\)/i.test(t)) aggRow.c = rows.length;
      return { rows: [aggRow], rowCount: 1 };
    }

    // ORDER BY ... LIMIT N
    const limitMatch = t.match(/LIMIT\s+(\d+)/i);
    const orderMatch = t.match(/ORDER BY\s+(\w+)\s*(DESC|ASC)?/i);
    if (orderMatch) {
      const col = orderMatch[1], dir = (orderMatch[2] || 'ASC').toUpperCase();
      rows.sort((a, b) => {
        const av = parseFloat(a[col]) || 0, bv = parseFloat(b[col]) || 0;
        return dir === 'DESC' ? bv - av : av - bv;
      });
    }
    if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1]));

    return { rows, rowCount: rows.length };
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────────
  if (updateMatch) {
    const whereMatch = t.match(/WHERE\s+(\w+)\s*=\s*\$(\d+)/i);
    if (whereMatch) {
      const col = whereMatch[1];
      const paramIdx = parseInt(whereMatch[2]) - 1;
      const setMatch = t.match(/SET\s+(.+?)\s+WHERE/is);
      if (setMatch) {
        const setPairs = setMatch[1].split(',').map(s => s.trim());
        table.forEach(row => {
          if (String(row[col]) === String(params[paramIdx])) {
            setPairs.forEach(pair => {
              const eqIdx = pair.indexOf('=');
              const k = pair.slice(0, eqIdx).trim();
              const v = pair.slice(eqIdx + 1).trim();
              const pIdx = parseInt((v.match(/\$(\d+)/) || [])[1]) - 1;
              if (!isNaN(pIdx) && params[pIdx] !== undefined) row[k] = params[pIdx];
            });
          }
        });
      }
    }
    return { rows: [], rowCount: 1 };
  }

  // ── DELETE ──────────────────────────────────────────────────────────────────
  if (deleteMatch) {
    const whereMatch = t.match(/WHERE\s+(\w+)\s*=\s*\$1/i);
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

  CREATE TABLE IF NOT EXISTS referrals (
    referral_id TEXT PRIMARY KEY,
    new_agent_did TEXT UNIQUE NOT NULL,
    referrer_did TEXT NOT NULL,
    referrer_wallet TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    converted_at TEXT,
    credit_issued_at TEXT,
    tx_hash TEXT,
    amount_usdc NUMERIC DEFAULT 1.00
  );

  CREATE TABLE IF NOT EXISTS usdc_sends (
    id SERIAL PRIMARY KEY,
    to_address TEXT NOT NULL,
    amount_usd NUMERIC NOT NULL,
    amount_usdc NUMERIC NOT NULL,
    reason TEXT,
    tx_hash TEXT,
    tx_id TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    referral_id TEXT,
    did TEXT,
    wallet_address TEXT,
    memo TEXT,
    dna JSONB
  );

  CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_did);
  CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
  CREATE INDEX IF NOT EXISTS idx_usdc_sends_address ON usdc_sends(to_address);
  CREATE INDEX IF NOT EXISTS idx_usdc_sends_created ON usdc_sends(created_at);

  CREATE TABLE IF NOT EXISTS rewards (
    id SERIAL PRIMARY KEY,
    did TEXT NOT NULL,
    trigger TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    tx_hash TEXT,
    claimed_at TEXT NOT NULL,
    dna JSONB,
    UNIQUE(did, trigger)
  );

  CREATE INDEX IF NOT EXISTS idx_rewards_did ON rewards(did);
`;

// Migrations: add columns to existing tables (safe — IF NOT EXISTS style via DO block)
const MIGRATIONS = `
  DO $$ BEGIN
    BEGIN ALTER TABLE referrals ADD COLUMN referrer_wallet TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE referrals ADD COLUMN tx_hash TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE referrals ADD COLUMN amount_usdc NUMERIC DEFAULT 1.00; EXCEPTION WHEN duplicate_column THEN NULL; END;
    -- DNA stamp columns
    BEGIN ALTER TABLE usdc_sends ADD COLUMN did TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE usdc_sends ADD COLUMN wallet_address TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE usdc_sends ADD COLUMN memo TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE usdc_sends ADD COLUMN dna JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE usdc_sends ADD COLUMN amount_usd NUMERIC; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE rewards ADD COLUMN dna JSONB; EXCEPTION WHEN duplicate_column THEN NULL; END;
  END $$;
`;

async function initialize() {
  if (useMemory) return; // already initialized above
  const client = await pool.connect();
  try {
    await client.query(DDL);
    await client.query(MIGRATIONS);
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
    // Return a fake client — handles BEGIN/COMMIT/ROLLBACK as no-ops
    return {
      query: (text, params) => Promise.resolve(memQuery(text, params || [])),
      release: () => {}
    };
  }
  return pool.connect();
}

// `all` is an alias for getAll — matches the API described in task spec
const all = getAll;

module.exports = { pool, initialize, query, getOne, getAll, all, run, getClient };
