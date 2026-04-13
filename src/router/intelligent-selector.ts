/**
 * Intelligent Model Selector
 * 
 * Selects optimal models based on:
 * 1. Use case classification
 * 2. Benchmark scores
 * 3. Tiered pricing (free-first, then cheapest)
 * 4. Quality thresholds
 */

/// <reference types="@cloudflare/workers-types" />

import type { UseCase, Complexity } from './use-case-classifier';

// =============================================================================
// Types
// =============================================================================

export interface ModelCandidate {
  id: string;
  provider: string;
  name: string;
  is_free: boolean;
  input_cost_per_m: number;
  output_cost_per_m: number;
  context_length: number;
  supports_vision: boolean;
  supports_function_calling: boolean;
  supports_json_mode: boolean;
  status: string;
  // Benchmark scores
  bench_humaneval: number | null;
  bench_mbpp: number | null;
  bench_mmlu: number | null;
  bench_arc: number | null;
  bench_gsm8k: number | null;
  bench_math: number | null;
  bench_ifeval: number | null;
  bench_mt_bench: number | null;
  // Computed scores
  score_coding: number | null;
  score_reasoning: number | null;
  score_knowledge: number | null;
  score_math: number | null;
  score_instruction: number | null;
  score_creative: number | null;
  score_overall: number | null;
}

export interface SelectionResult {
  model: ModelCandidate;
  score: number;
  tier: 'free' | 'ultra-cheap' | 'cheap' | 'standard' | 'premium';
  reason: string;
  fallback: boolean;
}

export interface SelectionOptions {
  useCase: UseCase;
  complexity: Complexity;
  qualityThreshold: number;
  benchmarkWeights: Record<string, number>;
  requireVision?: boolean;
  requireFunctionCalling?: boolean;
  requireJsonMode?: boolean;
  maxCostPerMillion?: number;
  preferredProviders?: string[];
  excludeProviders?: string[];
  excludeModels?: string[];
}

// =============================================================================
// Tier Definitions
// =============================================================================

const TIER_ORDER = ['free', 'ultra-cheap', 'cheap', 'standard', 'premium'] as const;

// Reasoning/thinking models that return empty content in standard chat completions
// These have high benchmark scores but don't work for normal chat use cases
const REASONING_MODEL_PATTERNS = [
  'deepseek-r1',    // DeepSeek R1 reasoning models
  '/o1',            // OpenAI o1 reasoning models  
  '/o3',            // OpenAI o3 reasoning models
  '-thinking',      // Models with thinking suffix
  '-think',         // Models with think suffix
];

function isReasoningModel(modelId: string): boolean {
  const lowerId = modelId.toLowerCase();
  return REASONING_MODEL_PATTERNS.some(pattern => lowerId.includes(pattern));
}

function classifyTier(model: ModelCandidate): typeof TIER_ORDER[number] {
  if (model.is_free || model.input_cost_per_m === 0) return 'free';
  if (model.input_cost_per_m < 0.1) return 'ultra-cheap';  // < $0.10/M tokens
  if (model.input_cost_per_m < 1) return 'cheap';          // < $1/M tokens
  if (model.input_cost_per_m < 10) return 'standard';      // < $10/M tokens
  return 'premium';
}

// =============================================================================
// Intelligent Model Selector Class
// =============================================================================

export class IntelligentModelSelector {
  private db: D1Database;
  private modelCache: ModelCandidate[] | null = null;
  private cacheExpiry: number = 0;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Select the best model for a given use case and complexity
   */
  async selectModel(options: SelectionOptions): Promise<SelectionResult> {
    const models = await this.getActiveModels();
    
    // Filter by requirements and compatibility
    let candidates = models.filter(m => {
      if (m.status !== 'active') return false;
      if (options.requireVision && !m.supports_vision) return false;
      if (options.requireFunctionCalling && !m.supports_function_calling) return false;
      if (options.requireJsonMode && !m.supports_json_mode) return false;
      if (options.maxCostPerMillion && m.input_cost_per_m > options.maxCostPerMillion) return false;
      if (options.excludeProviders?.includes(m.provider)) return false;
      if (options.excludeModels?.includes(m.id)) return false;
      // Exclude reasoning models that return empty content in standard chat
      if (isReasoningModel(m.id)) return false;
      return true;
    });

    // Prefer certain providers if specified
    if (options.preferredProviders?.length) {
      const preferredCandidates = candidates.filter(m => 
        options.preferredProviders!.includes(m.provider)
      );
      if (preferredCandidates.length > 0) {
        candidates = preferredCandidates;
      }
    }

    // Calculate weighted scores for each candidate
    const scored = candidates.map(model => ({
      model,
      score: this.calculateScore(model, options),
      tier: classifyTier(model),
    }));

    // Group by tier
    const byTier: Record<string, typeof scored> = {};
    for (const tier of TIER_ORDER) {
      byTier[tier] = scored.filter(s => s.tier === tier);
    }

    // Try each tier in order: free -> ultra-cheap -> cheap -> standard -> premium
    for (const tier of TIER_ORDER) {
      const tierModels = byTier[tier];
      if (tierModels.length === 0) continue;

      // Filter by quality threshold
      const qualified = tierModels.filter(s => s.score >= options.qualityThreshold);
      
      if (qualified.length > 0) {
        // Sort by score (descending), then by cost (ascending)
        qualified.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.model.input_cost_per_m - b.model.input_cost_per_m;
        });

        const best = qualified[0];
        return {
          model: best.model,
          score: best.score,
          tier: best.tier,
          reason: `Best ${tier} model for ${options.useCase} (score: ${best.score.toFixed(1)})`,
          fallback: false,
        };
      }
    }

    // No model met the quality threshold - use best available with reduced threshold
    const allScored = scored.filter(s => s.score > 0);
    if (allScored.length > 0) {
      allScored.sort((a, b) => {
        // Prioritize by tier first, then score
        const tierDiff = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
        if (tierDiff !== 0) return tierDiff;
        return b.score - a.score;
      });

      const best = allScored[0];
      return {
        model: best.model,
        score: best.score,
        tier: best.tier,
        reason: `Fallback: best available model (below threshold ${options.qualityThreshold})`,
        fallback: true,
      };
    }

    // Ultimate fallback
    const fallback = await this.getFallbackModel();
    return {
      model: fallback,
      score: 50,
      tier: 'cheap',
      reason: 'Ultimate fallback: no suitable models found',
      fallback: true,
    };
  }

  /**
   * Select multiple models for redundancy (primary + backups)
   */
  async selectModelsWithBackup(options: SelectionOptions, count: number = 3): Promise<SelectionResult[]> {
    const models = await this.getActiveModels();
    const results: SelectionResult[] = [];
    const excludeModels = new Set(options.excludeModels || []);

    for (let i = 0; i < count; i++) {
      const result = await this.selectModel({
        ...options,
        excludeModels: Array.from(excludeModels),
      });
      
      results.push(result);
      excludeModels.add(result.model.id);
    }

    return results;
  }

  /**
   * Calculate weighted score for a model based on use case
   */
  private calculateScore(model: ModelCandidate, options: SelectionOptions): number {
    const weights = options.benchmarkWeights;
    let score = 0;
    let totalWeight = 0;

    for (const [benchmark, weight] of Object.entries(weights)) {
      const value = (model as any)[benchmark] as number | null;
      if (value !== null && value !== undefined) {
        score += value * weight;
        totalWeight += weight;
      }
    }

    // Normalize to 0-100
    if (totalWeight > 0) {
      score = score / totalWeight;
    } else {
      // Fallback to overall score if no benchmark weights match
      score = model.score_overall || 50;
    }

    // Apply complexity bonus for premium models on complex tasks
    if (options.complexity === 'complex' && classifyTier(model) === 'premium') {
      score *= 1.05; // 5% bonus for premium on complex tasks
    }

    // Apply penalty for potential mismatches
    if (options.useCase === 'coding' && model.score_coding !== null && model.score_coding < 60) {
      score *= 0.9; // 10% penalty for weak coding models on coding tasks
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Get active models from D1 with caching
   */
  private async getActiveModels(): Promise<ModelCandidate[]> {
    const now = Date.now();
    
    if (this.modelCache && now < this.cacheExpiry) {
      return this.modelCache;
    }

    const result = await this.db.prepare(`
      SELECT 
        id, provider, name, is_free, input_cost_per_m, output_cost_per_m,
        context_length, supports_vision, supports_function_calling, supports_json_mode, status,
        bench_humaneval, bench_mbpp, bench_mmlu, bench_arc, bench_gsm8k, bench_math,
        bench_ifeval, bench_mt_bench,
        score_coding, score_reasoning, score_knowledge, score_math, 
        score_instruction, score_creative, score_overall
      FROM models
      WHERE status = 'active'
      ORDER BY is_free DESC, input_cost_per_m ASC
    `).all<ModelCandidate>();

    const models = result.results || [];
    this.modelCache = models;
    this.cacheExpiry = now + this.CACHE_TTL_MS;

    return models;
  }

  /**
   * Get a reliable fallback model
   */
  private async getFallbackModel(): Promise<ModelCandidate> {
    // Try to get a known reliable model
    const result = await this.db.prepare(`
      SELECT * FROM models 
      WHERE id IN (
        'openai/gpt-4o-mini',
        'anthropic/claude-3-haiku',
        'google/gemini-flash-1.5'
      )
      AND status = 'active'
      ORDER BY input_cost_per_m ASC
      LIMIT 1
    `).first<ModelCandidate>();

    if (result) {
      return result;
    }

    // Ultimate fallback
    return {
      id: 'openai/gpt-4o-mini',
      provider: 'openai',
      name: 'GPT-4o Mini',
      is_free: false,
      input_cost_per_m: 0.15,
      output_cost_per_m: 0.6,
      context_length: 128000,
      supports_vision: true,
      supports_function_calling: true,
      supports_json_mode: true,
      status: 'active',
      bench_humaneval: 87,
      bench_mbpp: 83,
      bench_mmlu: 82,
      bench_arc: 93,
      bench_gsm8k: 93,
      bench_math: 70,
      bench_ifeval: 80,
      bench_mt_bench: 9.1,
      score_coding: 84,
      score_reasoning: 80,
      score_knowledge: 82,
      score_math: 81,
      score_instruction: 80,
      score_creative: 78,
      score_overall: 81,
    };
  }

  /**
   * Invalidate cache (call after model discovery)
   */
  invalidateCache(): void {
    this.modelCache = null;
    this.cacheExpiry = 0;
  }

  /**
   * Get model by ID
   */
  async getModelById(id: string): Promise<ModelCandidate | null> {
    const result = await this.db.prepare(
      'SELECT * FROM models WHERE id = ?'
    ).bind(id).first<ModelCandidate>();
    
    return result || null;
  }

  /**
   * Update model status (for cooldown management)
   */
  async updateModelStatus(
    modelId: string, 
    status: 'active' | 'degraded' | 'disabled' | 'cooldown',
    cooldownUntil?: number
  ): Promise<void> {
    if (cooldownUntil) {
      await this.db.prepare(`
        UPDATE models SET status = ?, cooldown_until = ?, updated_at = ?
        WHERE id = ?
      `).bind(status, cooldownUntil, Date.now(), modelId).run();
    } else {
      await this.db.prepare(`
        UPDATE models SET status = ?, cooldown_until = NULL, updated_at = ?
        WHERE id = ?
      `).bind(status, Date.now(), modelId).run();
    }
    
    this.invalidateCache();
  }

  /**
   * Get statistics about available models
   */
  async getModelStats(): Promise<{
    total: number;
    byTier: Record<string, number>;
    byProvider: Record<string, number>;
    withBenchmarks: number;
  }> {
    const models = await this.getActiveModels();
    
    const stats = {
      total: models.length,
      byTier: {} as Record<string, number>,
      byProvider: {} as Record<string, number>,
      withBenchmarks: 0,
    };

    for (const model of models) {
      const tier = classifyTier(model);
      stats.byTier[tier] = (stats.byTier[tier] || 0) + 1;
      stats.byProvider[model.provider] = (stats.byProvider[model.provider] || 0) + 1;
      if (model.score_overall !== null) {
        stats.withBenchmarks++;
      }
    }

    return stats;
  }
}
