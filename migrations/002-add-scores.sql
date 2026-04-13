-- Migration 002: Add computed score columns and use_case table
-- Created: 2026-01-19

-- Add computed use-case scores to models table
ALTER TABLE models ADD COLUMN score_coding REAL;
ALTER TABLE models ADD COLUMN score_reasoning REAL;
ALTER TABLE models ADD COLUMN score_knowledge REAL;
ALTER TABLE models ADD COLUMN score_math REAL;
ALTER TABLE models ADD COLUMN score_instruction REAL;
ALTER TABLE models ADD COLUMN score_creative REAL;
ALTER TABLE models ADD COLUMN score_overall REAL;

-- Create indexes for fast score-based queries
CREATE INDEX IF NOT EXISTS idx_models_score_coding ON models(score_coding);
CREATE INDEX IF NOT EXISTS idx_models_score_reasoning ON models(score_reasoning);
CREATE INDEX IF NOT EXISTS idx_models_score_overall ON models(score_overall);
CREATE INDEX IF NOT EXISTS idx_models_is_free ON models(is_free);

-- Create use_case_config table for classification settings
CREATE TABLE IF NOT EXISTS use_case_config (
  use_case TEXT PRIMARY KEY,
  keywords TEXT NOT NULL,           -- JSON array of keywords
  patterns TEXT,                    -- JSON array of regex patterns
  benchmark_weights TEXT NOT NULL,  -- JSON object: benchmark -> weight
  quality_threshold_simple REAL DEFAULT 30,
  quality_threshold_moderate REAL DEFAULT 50,
  quality_threshold_complex REAL DEFAULT 70,
  updated_at INTEGER NOT NULL
);
