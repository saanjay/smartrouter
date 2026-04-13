-- Migration 003: Seed benchmark data for known models
-- Data sources: OpenRouter benchmarks, Hugging Face Open LLM Leaderboard, LMSYS Arena
-- Created: 2026-01-19

-- GPT-4o series
UPDATE models SET 
  bench_humaneval = 90.2, bench_mbpp = 87.5, bench_mmlu = 87.2, bench_arc = 96.4,
  bench_gsm8k = 95.8, bench_math = 76.6, bench_ifeval = 84.3, bench_mt_bench = 9.32,
  score_coding = 88, score_reasoning = 85, score_knowledge = 87, score_math = 86, 
  score_instruction = 84, score_creative = 82, score_overall = 85
WHERE id LIKE 'openai/gpt-4o%' AND id NOT LIKE '%mini%';

UPDATE models SET 
  bench_humaneval = 87.2, bench_mbpp = 83.5, bench_mmlu = 82.0, bench_arc = 93.4,
  bench_gsm8k = 93.2, bench_math = 70.2, bench_ifeval = 80.5, bench_mt_bench = 9.10,
  score_coding = 84, score_reasoning = 80, score_knowledge = 82, score_math = 81, 
  score_instruction = 80, score_creative = 78, score_overall = 81
WHERE id LIKE 'openai/gpt-4o-mini%';

-- GPT-4.1 series
UPDATE models SET 
  bench_humaneval = 91.0, bench_mbpp = 89.0, bench_mmlu = 88.5, bench_arc = 97.0,
  bench_gsm8k = 96.5, bench_math = 78.0, bench_ifeval = 86.0, bench_mt_bench = 9.45,
  score_coding = 90, score_reasoning = 87, score_knowledge = 88, score_math = 87, 
  score_instruction = 86, score_creative = 84, score_overall = 87
WHERE id LIKE 'openai/gpt-4.1%';

-- O1 reasoning models
UPDATE models SET 
  bench_humaneval = 92.4, bench_mbpp = 93.0, bench_mmlu = 91.8, bench_arc = 97.8,
  bench_gsm8k = 98.9, bench_math = 94.8, bench_ifeval = 85.0, bench_mt_bench = 9.38,
  score_coding = 93, score_reasoning = 96, score_knowledge = 92, score_math = 96, 
  score_instruction = 85, score_creative = 75, score_overall = 90
WHERE id LIKE 'openai/o1%' AND id NOT LIKE '%mini%' AND id NOT LIKE '%preview%';

UPDATE models SET 
  bench_humaneval = 90.0, bench_mbpp = 91.5, bench_mmlu = 89.2, bench_arc = 96.5,
  bench_gsm8k = 97.5, bench_math = 90.0, bench_ifeval = 82.0, bench_mt_bench = 9.15,
  score_coding = 90, score_reasoning = 92, score_knowledge = 89, score_math = 93, 
  score_instruction = 82, score_creative = 72, score_overall = 87
WHERE id LIKE 'openai/o1-mini%';

UPDATE models SET 
  bench_humaneval = 89.5, bench_mbpp = 88.0, bench_mmlu = 87.0, bench_arc = 95.0,
  bench_gsm8k = 95.0, bench_math = 85.0, bench_ifeval = 80.0, bench_mt_bench = 9.0,
  score_coding = 88, score_reasoning = 88, score_knowledge = 87, score_math = 89, 
  score_instruction = 80, score_creative = 70, score_overall = 84
WHERE id LIKE 'openai/o3-mini%';

-- Claude 3.5/4 series
UPDATE models SET 
  bench_humaneval = 92.0, bench_mbpp = 91.0, bench_mmlu = 88.7, bench_arc = 96.5,
  bench_gsm8k = 96.4, bench_math = 71.1, bench_ifeval = 88.0, bench_mt_bench = 9.41,
  score_coding = 92, score_reasoning = 88, score_knowledge = 89, score_math = 84, 
  score_instruction = 88, score_creative = 90, score_overall = 89
WHERE id LIKE 'anthropic/claude-3.5-sonnet%' OR id LIKE 'anthropic/claude-sonnet-4%';

UPDATE models SET 
  bench_humaneval = 75.9, bench_mbpp = 80.4, bench_mmlu = 75.2, bench_arc = 85.4,
  bench_gsm8k = 88.9, bench_math = 38.9, bench_ifeval = 75.0, bench_mt_bench = 8.81,
  score_coding = 78, score_reasoning = 75, score_knowledge = 75, score_math = 64, 
  score_instruction = 75, score_creative = 80, score_overall = 75
WHERE id LIKE 'anthropic/claude-3-haiku%';

UPDATE models SET 
  bench_humaneval = 84.9, bench_mbpp = 84.1, bench_mmlu = 86.8, bench_arc = 93.2,
  bench_gsm8k = 95.0, bench_math = 60.1, bench_ifeval = 82.0, bench_mt_bench = 9.18,
  score_coding = 84, score_reasoning = 84, score_knowledge = 87, score_math = 78, 
  score_instruction = 82, score_creative = 86, score_overall = 84
WHERE id LIKE 'anthropic/claude-3-opus%';

-- Gemini series
UPDATE models SET 
  bench_humaneval = 89.8, bench_mbpp = 88.6, bench_mmlu = 88.7, bench_arc = 96.2,
  bench_gsm8k = 94.4, bench_math = 68.0, bench_ifeval = 82.0, bench_mt_bench = 9.25,
  score_coding = 88, score_reasoning = 85, score_knowledge = 89, score_math = 81, 
  score_instruction = 82, score_creative = 84, score_overall = 85
WHERE id LIKE 'google/gemini-pro%' OR id LIKE 'google/gemini-1.5-pro%';

UPDATE models SET 
  bench_humaneval = 85.5, bench_mbpp = 84.0, bench_mmlu = 82.0, bench_arc = 92.5,
  bench_gsm8k = 91.5, bench_math = 60.0, bench_ifeval = 78.0, bench_mt_bench = 8.95,
  score_coding = 84, score_reasoning = 80, score_knowledge = 82, score_math = 76, 
  score_instruction = 78, score_creative = 80, score_overall = 80
WHERE id LIKE 'google/gemini-flash%' OR id LIKE 'google/gemini-2.0-flash%';

-- DeepSeek series
UPDATE models SET 
  bench_humaneval = 88.5, bench_mbpp = 85.0, bench_mmlu = 87.5, bench_arc = 92.5,
  bench_gsm8k = 93.0, bench_math = 75.0, bench_ifeval = 78.0, bench_mt_bench = 9.0,
  score_coding = 87, score_reasoning = 85, score_knowledge = 87, score_math = 84, 
  score_instruction = 78, score_creative = 75, score_overall = 83
WHERE id LIKE 'deepseek/deepseek-chat%' OR id LIKE 'deepseek/deepseek-v3%';

UPDATE models SET 
  bench_humaneval = 90.2, bench_mbpp = 88.0, bench_mmlu = 80.0, bench_arc = 88.0,
  bench_gsm8k = 85.0, bench_math = 65.0, bench_ifeval = 72.0, bench_mt_bench = 8.5,
  score_coding = 90, score_reasoning = 78, score_knowledge = 80, score_math = 75, 
  score_instruction = 72, score_creative = 65, score_overall = 77
WHERE id LIKE 'deepseek/deepseek-coder%';

UPDATE models SET 
  bench_humaneval = 92.8, bench_mbpp = 92.0, bench_mmlu = 90.8, bench_arc = 95.0,
  bench_gsm8k = 97.3, bench_math = 90.2, bench_ifeval = 83.0, bench_mt_bench = 9.35,
  score_coding = 92, score_reasoning = 93, score_knowledge = 91, score_math = 93, 
  score_instruction = 83, score_creative = 78, score_overall = 88
WHERE id LIKE 'deepseek/deepseek-r1%';

-- Llama 3.x series
UPDATE models SET 
  bench_humaneval = 81.7, bench_mbpp = 82.5, bench_mmlu = 86.0, bench_arc = 93.0,
  bench_gsm8k = 93.0, bench_math = 51.0, bench_ifeval = 78.0, bench_mt_bench = 8.90,
  score_coding = 82, score_reasoning = 80, score_knowledge = 86, score_math = 72, 
  score_instruction = 78, score_creative = 76, score_overall = 79
WHERE id LIKE 'meta-llama/llama-3.1-70b%' OR id LIKE 'meta-llama/llama-3.3-70b%';

UPDATE models SET 
  bench_humaneval = 72.6, bench_mbpp = 74.5, bench_mmlu = 73.0, bench_arc = 83.4,
  bench_gsm8k = 84.5, bench_math = 35.0, bench_ifeval = 70.0, bench_mt_bench = 8.19,
  score_coding = 73, score_reasoning = 72, score_knowledge = 73, score_math = 60, 
  score_instruction = 70, score_creative = 72, score_overall = 70
WHERE id LIKE 'meta-llama/llama-3.1-8b%' OR id LIKE 'meta-llama/llama-3.2-8b%';

UPDATE models SET 
  bench_humaneval = 85.0, bench_mbpp = 84.5, bench_mmlu = 88.5, bench_arc = 95.0,
  bench_gsm8k = 95.0, bench_math = 68.0, bench_ifeval = 82.0, bench_mt_bench = 9.10,
  score_coding = 84, score_reasoning = 84, score_knowledge = 88, score_math = 82, 
  score_instruction = 82, score_creative = 80, score_overall = 84
WHERE id LIKE 'meta-llama/llama-3.1-405b%';

-- Qwen series
UPDATE models SET 
  bench_humaneval = 92.7, bench_mbpp = 90.5, bench_mmlu = 83.0, bench_arc = 88.0,
  bench_gsm8k = 89.0, bench_math = 72.0, bench_ifeval = 75.0, bench_mt_bench = 8.6,
  score_coding = 92, score_reasoning = 82, score_knowledge = 83, score_math = 80, 
  score_instruction = 75, score_creative = 70, score_overall = 80
WHERE id LIKE 'qwen/qwen-2.5-coder%' OR id LIKE 'qwen/qwq%' OR id LIKE 'qwen/qwen3-coder%';

UPDATE models SET 
  bench_humaneval = 85.0, bench_mbpp = 82.0, bench_mmlu = 85.0, bench_arc = 91.0,
  bench_gsm8k = 91.5, bench_math = 65.0, bench_ifeval = 78.0, bench_mt_bench = 8.85,
  score_coding = 84, score_reasoning = 82, score_knowledge = 85, score_math = 78, 
  score_instruction = 78, score_creative = 75, score_overall = 80
WHERE id LIKE 'qwen/qwen-2.5-72b%';

-- Mistral series
UPDATE models SET 
  bench_humaneval = 81.1, bench_mbpp = 78.0, bench_mmlu = 84.0, bench_arc = 91.0,
  bench_gsm8k = 90.0, bench_math = 45.0, bench_ifeval = 75.0, bench_mt_bench = 8.52,
  score_coding = 80, score_reasoning = 78, score_knowledge = 84, score_math = 68, 
  score_instruction = 75, score_creative = 78, score_overall = 77
WHERE id LIKE 'mistralai/mistral-large%';

UPDATE models SET 
  bench_humaneval = 88.4, bench_mbpp = 85.0, bench_mmlu = 78.0, bench_arc = 85.0,
  bench_gsm8k = 82.0, bench_math = 55.0, bench_ifeval = 72.0, bench_mt_bench = 8.2,
  score_coding = 88, score_reasoning = 76, score_knowledge = 78, score_math = 69, 
  score_instruction = 72, score_creative = 68, score_overall = 75
WHERE id LIKE 'mistralai/codestral%';

UPDATE models SET 
  bench_humaneval = 68.0, bench_mbpp = 65.0, bench_mmlu = 62.5, bench_arc = 75.0,
  bench_gsm8k = 52.2, bench_math = 28.0, bench_ifeval = 60.0, bench_mt_bench = 7.6,
  score_coding = 66, score_reasoning = 60, score_knowledge = 63, score_math = 40, 
  score_instruction = 60, score_creative = 65, score_overall = 59
WHERE id LIKE 'mistralai/mistral-7b%';

-- Free models (conservative estimates based on base model benchmarks)
UPDATE models SET 
  bench_humaneval = 65.0, bench_mbpp = 62.0, bench_mmlu = 60.0, bench_arc = 72.0,
  bench_gsm8k = 50.0, bench_math = 25.0, bench_ifeval = 55.0, bench_mt_bench = 7.2,
  score_coding = 63, score_reasoning = 58, score_knowledge = 60, score_math = 38, 
  score_instruction = 55, score_creative = 60, score_overall = 56
WHERE is_free = 1 AND score_overall IS NULL;

-- Seed use_case_config
INSERT OR REPLACE INTO use_case_config (use_case, keywords, benchmark_weights, quality_threshold_simple, quality_threshold_moderate, quality_threshold_complex, updated_at) VALUES
('coding', 
 '["code","coding","programming","debug","function","implement","algorithm","script","api","endpoint","typescript","javascript","python","sql","fix bug","refactor","test"]',
 '{"bench_humaneval":0.4,"bench_mbpp":0.3,"score_coding":0.3}',
 50, 70, 85, strftime('%s','now') * 1000),

('reasoning', 
 '["reason","analyze","think","explain why","logic","deduce","infer","evaluate","compare","contrast","pros and cons","decision","strategy"]',
 '{"bench_arc":0.3,"bench_gsm8k":0.2,"score_reasoning":0.5}',
 55, 72, 88, strftime('%s','now') * 1000),

('knowledge', 
 '["what is","define","explain","describe","tell me about","information","facts","history","science","geography","who","when","where"]',
 '{"bench_mmlu":0.5,"score_knowledge":0.5}',
 50, 65, 80, strftime('%s','now') * 1000),

('math', 
 '["calculate","compute","solve","equation","formula","math","arithmetic","algebra","geometry","statistics","probability","number"]',
 '{"bench_gsm8k":0.3,"bench_math":0.4,"score_math":0.3}',
 55, 75, 90, strftime('%s','now') * 1000),

('creative', 
 '["write","create","generate","story","poem","email","letter","content","blog","article","creative","imagine","brainstorm"]',
 '{"bench_mt_bench":0.4,"score_creative":0.6}',
 45, 60, 75, strftime('%s','now') * 1000),

('instruction', 
 '["how to","steps to","guide","instructions","tutorial","process","workflow","procedure"]',
 '{"bench_ifeval":0.5,"score_instruction":0.5}',
 50, 68, 82, strftime('%s','now') * 1000),

('general', 
 '["help","assist","chat","question","answer"]',
 '{"score_overall":1.0}',
 45, 60, 75, strftime('%s','now') * 1000);
