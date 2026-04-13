-- Migration 001: Initial AI Router Schema
-- Created: 2026-01-19

-- Models Table
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  display_name TEXT,
  context_length INTEGER NOT NULL,
  supports_vision BOOLEAN DEFAULT FALSE,
  supports_tools BOOLEAN DEFAULT FALSE,
  supports_structured_output BOOLEAN DEFAULT FALSE,
  pricing_input REAL NOT NULL DEFAULT 0,
  pricing_output REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL CHECK (tier IN ('free', 'ultra-cheap', 'cheap', 'standard', 'premium')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'degraded', 'disabled', 'cooldown')),
  cooldown_until INTEGER,
  avg_latency_ms REAL,
  success_rate REAL,
  discovered_at INTEGER NOT NULL,
  last_validated_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Benchmarks Table
CREATE TABLE IF NOT EXISTS model_benchmarks (
  model_id TEXT PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  humaneval REAL,
  mbpp REAL,
  livecodebench REAL,
  swebench REAL,
  gpqa REAL,
  arc_challenge REAL,
  bbh REAL,
  mmlu REAL,
  mmlu_pro REAL,
  gsm8k REAL,
  math_benchmark REAL,
  aime REAL,
  ifeval REAL,
  mtbench REAL,
  arena_elo REAL,
  arena_coding_elo REAL,
  score_coding REAL,
  score_reasoning REAL,
  score_knowledge REAL,
  score_math REAL,
  score_instruction REAL,
  score_creative REAL,
  score_overall REAL,
  source TEXT,
  updated_at INTEGER NOT NULL
);

-- Use Case Centroids
CREATE TABLE IF NOT EXISTS use_case_centroids (
  use_case TEXT PRIMARY KEY,
  centroid_embedding BLOB,
  keywords TEXT,
  patterns TEXT,
  benchmark_weights TEXT,
  updated_at INTEGER NOT NULL
);

-- Usage Logs
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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_models_tier ON models(tier);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider);
CREATE INDEX IF NOT EXISTS idx_benchmarks_coding ON model_benchmarks(score_coding);
CREATE INDEX IF NOT EXISTS idx_benchmarks_reasoning ON model_benchmarks(score_reasoning);
CREATE INDEX IF NOT EXISTS idx_benchmarks_overall ON model_benchmarks(score_overall);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_logs(model_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_usecase ON usage_logs(use_case, created_at);
