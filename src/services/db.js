const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_URL || path.join(__dirname, '..', '..', 'hivebank.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS vaults (
    vault_id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    balance_usdc REAL DEFAULT 0,
    total_deposited_usdc REAL DEFAULT 0,
    total_withdrawn_usdc REAL DEFAULT 0,
    yield_earned_usdc REAL DEFAULT 0,
    platform_yield_fee_usdc REAL DEFAULT 0,
    yield_rate_apy REAL DEFAULT 0.06,
    created_at TEXT,
    last_yield_accrual TEXT
  );

  CREATE TABLE IF NOT EXISTS vault_transactions (
    transaction_id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    did TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    balance_after REAL,
    source TEXT,
    memo TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS budget_delegations (
    delegation_id TEXT PRIMARY KEY,
    orchestrator_did TEXT NOT NULL,
    child_did TEXT NOT NULL,
    max_per_tx_usdc REAL,
    max_per_day_usdc REAL,
    approved_counterparties TEXT,
    approved_categories TEXT,
    daily_spent_usdc REAL DEFAULT 0,
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
    amount_usdc REAL,
    category TEXT,
    approved INTEGER,
    reason TEXT,
    fee_usdc REAL DEFAULT 0.001,
    evaluated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS credit_lines (
    credit_id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    credit_limit_usdc REAL DEFAULT 0,
    outstanding_usdc REAL DEFAULT 0,
    interest_accrued_usdc REAL DEFAULT 0,
    interest_rate_apr REAL,
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
    amount_usdc REAL NOT NULL,
    outstanding_after REAL,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS revenue_streams (
    stream_id TEXT PRIMARY KEY,
    from_did TEXT NOT NULL,
    to_did TEXT NOT NULL,
    total_usdc REAL NOT NULL,
    rate_per_second_usdc REAL NOT NULL,
    streamed_usdc REAL DEFAULT 0,
    platform_fee_usdc REAL DEFAULT 0,
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
    total_deposits_usdc REAL DEFAULT 0,
    total_yield_generated_usdc REAL DEFAULT 0,
    platform_yield_revenue_usdc REAL DEFAULT 0,
    total_credit_outstanding_usdc REAL DEFAULT 0,
    total_streamed_volume_usdc REAL DEFAULT 0,
    budget_evaluations_total INTEGER DEFAULT 0,
    last_updated TEXT
  );

  INSERT OR IGNORE INTO bank_stats (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS perf_credit_lines (
    id TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    approved_usdc REAL DEFAULT 0,
    drawn_usdc REAL DEFAULT 0,
    repaid_usdc REAL DEFAULT 0,
    interest_rate_pct REAL,
    interest_accrued_usdc REAL DEFAULT 0,
    term_days INTEGER,
    status TEXT DEFAULT 'active',
    performance_score REAL,
    created_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS perf_credit_transactions (
    id TEXT PRIMARY KEY,
    credit_line_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    purpose TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bonds (
    id TEXT PRIMARY KEY,
    did TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    lock_period_days INTEGER NOT NULL,
    apy_pct REAL NOT NULL,
    yield_earned_usdc REAL DEFAULT 0,
    staked_at TEXT,
    maturity_date TEXT,
    unstaked_at TEXT,
    status TEXT DEFAULT 'active',
    early_withdrawal_penalty_usdc REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS cashback_accounts (
    id TEXT PRIMARY KEY,
    did TEXT UNIQUE NOT NULL,
    balance_usdc REAL DEFAULT 0,
    total_earned_usdc REAL DEFAULT 0,
    total_spent_usdc REAL DEFAULT 0,
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
    amount_usdc REAL NOT NULL,
    source_service TEXT,
    description TEXT,
    created_at TEXT
  );
`);

module.exports = db;
