-- Migration 004: Add usage_logs table for intelligent router analytics
-- Created: 2026-01-19

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  use_case TEXT NOT NULL,
  complexity TEXT CHECK (complexity IN ('simple', 'moderate', 'complex')),
  prompt_hash TEXT,
  model_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  benchmark_score REAL,
  selection_reason TEXT,
  tokens_input INTEGER,
  tokens_output INTEGER,
  latency_ms INTEGER,
  cost_usd REAL,
  cached BOOLEAN DEFAULT FALSE,
  success BOOLEAN DEFAULT TRUE,
  error_code TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_usecase ON usage_logs(use_case, created_at);
