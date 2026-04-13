/**
 * Quality Tracker (v2.0)
 * 
 * Tracks model performance in real-time:
 * - Success/failure rates per model per operation
 * - Latency percentiles (P50, P95, P99)
 * - Token efficiency
 * - Automatic model promotion/demotion
 * 
 * Uses Thompson Sampling for intelligent exploration vs exploitation
 */

/// <reference types="@cloudflare/workers-types" />

import type { Operation, Tier } from './types';

// =============================================================================
// Types
// =============================================================================

export interface ModelQualityStats {
  modelId: string;
  operation: string;
  successes: number;
  failures: number;
  successRate: number;
  totalTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  lastUpdated: number;
  // Thompson Sampling parameters
  alpha: number;  // successes + 1
  beta: number;   // failures + 1
}

export interface QualitySignal {
  modelId: string;
  operation: Operation;
  success: boolean;
  latencyMs: number;
  tokens: number;
  cost: number;
  errorCode?: number;
  errorMessage?: string;
}

export interface ModelRanking {
  modelId: string;
  score: number;          // Thompson sample
  successRate: number;
  avgLatency: number;
  tier: Tier;
  confidence: 'low' | 'medium' | 'high';  // Based on sample size
}

// =============================================================================
// Quality Tracker Class
// =============================================================================

export class QualityTracker {
  private kv: KVNamespace;
  private latencyBuffer: Map<string, number[]> = new Map();  // In-memory for percentiles
  private readonly MAX_LATENCY_SAMPLES = 100;
  
  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  // ===========================================================================
  // Record Quality Signal
  // ===========================================================================

  /**
   * Record a quality signal for a model
   */
  async recordSignal(signal: QualitySignal): Promise<void> {
    const key = this.getStatsKey(signal.modelId, signal.operation);
    
    // Load existing stats
    let stats = await this.getStats(signal.modelId, signal.operation);
    
    if (!stats) {
      stats = this.createEmptyStats(signal.modelId, signal.operation);
    }
    
    // Update stats
    if (signal.success) {
      stats.successes++;
      stats.alpha++;
    } else {
      stats.failures++;
      stats.beta++;
    }
    
    stats.totalTokens += signal.tokens;
    stats.totalCost += signal.cost;
    
    // Update latency (rolling average)
    const totalCalls = stats.successes + stats.failures;
    stats.avgLatencyMs = ((stats.avgLatencyMs * (totalCalls - 1)) + signal.latencyMs) / totalCalls;
    
    // Update success rate
    stats.successRate = stats.successes / totalCalls;
    
    stats.lastUpdated = Date.now();
    
    // Persist
    await this.kv.put(key, JSON.stringify(stats), {
      expirationTtl: 60 * 60 * 24 * 7,  // 7 days
    });
    
    // Update latency buffer for percentiles
    this.updateLatencyBuffer(signal.modelId, signal.operation, signal.latencyMs);
    
    // Log for observability
    console.log(`[QualityTracker] ${signal.modelId}:${signal.operation} | ` +
      `Success: ${signal.success} | Rate: ${(stats.successRate * 100).toFixed(1)}% | ` +
      `Calls: ${totalCalls} | Cost: $${stats.totalCost.toFixed(4)}`);
  }

  // ===========================================================================
  // Thompson Sampling for Model Selection
  // ===========================================================================

  /**
   * Get ranked models for an operation using Thompson Sampling
   */
  async getRankedModels(
    operation: Operation,
    modelIds: string[],
    tiers: Map<string, Tier>
  ): Promise<ModelRanking[]> {
    const rankings: ModelRanking[] = [];
    
    for (const modelId of modelIds) {
      const stats = await this.getStats(modelId, operation);
      
      // Thompson sample: draw from Beta(alpha, beta)
      let score: number;
      let confidence: 'low' | 'medium' | 'high';
      
      if (stats) {
        score = this.betaSample(stats.alpha, stats.beta);
        const totalCalls = stats.successes + stats.failures;
        confidence = totalCalls < 10 ? 'low' : totalCalls < 50 ? 'medium' : 'high';
        
        rankings.push({
          modelId,
          score,
          successRate: stats.successRate,
          avgLatency: stats.avgLatencyMs,
          tier: tiers.get(modelId) || 'cheap',
          confidence,
        });
      } else {
        // No data: optimistic prior (explore new models)
        score = this.betaSample(1, 1);  // Uniform prior
        rankings.push({
          modelId,
          score,
          successRate: 0.5,  // Unknown
          avgLatency: 0,
          tier: tiers.get(modelId) || 'cheap',
          confidence: 'low',
        });
      }
    }
    
    // Sort by Thompson sample score (highest first)
    rankings.sort((a, b) => b.score - a.score);
    
    return rankings;
  }

  /**
   * Beta distribution sampling using Box-Muller approximation
   * For Thompson Sampling multi-armed bandit
   */
  private betaSample(alpha: number, beta: number): number {
    // Use gamma function approximation for beta distribution
    const gammaAlpha = this.gammaSample(alpha);
    const gammaBeta = this.gammaSample(beta);
    return gammaAlpha / (gammaAlpha + gammaBeta);
  }

  /**
   * Gamma distribution sampling (Marsaglia and Tsang's method)
   */
  private gammaSample(shape: number): number {
    if (shape < 1) {
      return this.gammaSample(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    
    while (true) {
      let x: number, v: number;
      
      do {
        x = this.normalSample();
        v = 1 + c * x;
      } while (v <= 0);
      
      v = v * v * v;
      const u = Math.random();
      
      if (u < 1 - 0.0331 * (x * x) * (x * x)) {
        return d * v;
      }
      
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v;
      }
    }
  }

  /**
   * Standard normal sampling (Box-Muller transform)
   */
  private normalSample(): number {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get stats for a model/operation pair
   */
  async getStats(modelId: string, operation: string): Promise<ModelQualityStats | null> {
    const key = this.getStatsKey(modelId, operation);
    const data = await this.kv.get(key);
    
    if (!data) return null;
    
    try {
      return JSON.parse(data) as ModelQualityStats;
    } catch {
      return null;
    }
  }

  /**
   * Get all stats for an operation (for dashboard)
   */
  async getAllStatsForOperation(operation: string): Promise<ModelQualityStats[]> {
    const prefix = `quality:${operation}:`;
    const list = await this.kv.list({ prefix });
    
    const stats: ModelQualityStats[] = [];
    
    for (const key of list.keys) {
      const data = await this.kv.get(key.name);
      if (data) {
        try {
          stats.push(JSON.parse(data) as ModelQualityStats);
        } catch {
          // Skip invalid entries
        }
      }
    }
    
    return stats;
  }

  /**
   * Get top performing models for an operation
   */
  async getTopModels(operation: string, limit: number = 10): Promise<ModelQualityStats[]> {
    const allStats = await this.getAllStatsForOperation(operation);
    
    // Filter out models with low confidence (< 10 calls)
    const confidentStats = allStats.filter(s => (s.successes + s.failures) >= 10);
    
    // Sort by success rate
    confidentStats.sort((a, b) => b.successRate - a.successRate);
    
    return confidentStats.slice(0, limit);
  }

  /**
   * Get problematic models (for automatic demotion)
   */
  async getProblematicModels(
    operation: string,
    minCalls: number = 10,
    maxErrorRate: number = 0.20
  ): Promise<string[]> {
    const allStats = await this.getAllStatsForOperation(operation);
    
    return allStats
      .filter(s => {
        const totalCalls = s.successes + s.failures;
        return totalCalls >= minCalls && s.successRate < (1 - maxErrorRate);
      })
      .map(s => s.modelId);
  }

  /**
   * Check if a model should be avoided
   */
  async shouldAvoidModel(
    modelId: string,
    operation: string,
    threshold: number = 0.80  // 80% success rate minimum
  ): Promise<boolean> {
    const stats = await this.getStats(modelId, operation);
    
    if (!stats) return false;  // No data, don't avoid
    
    const totalCalls = stats.successes + stats.failures;
    
    // Need at least 10 calls for confidence
    if (totalCalls < 10) return false;
    
    return stats.successRate < threshold;
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private getStatsKey(modelId: string, operation: string): string {
    // Encode model ID for KV key safety
    const safeModelId = modelId.replace(/[:/]/g, '_');
    return `quality:${operation}:${safeModelId}`;
  }

  private createEmptyStats(modelId: string, operation: string): ModelQualityStats {
    return {
      modelId,
      operation,
      successes: 0,
      failures: 0,
      successRate: 0,
      totalTokens: 0,
      totalCost: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      p99LatencyMs: 0,
      lastUpdated: Date.now(),
      alpha: 1,  // Prior: Beta(1, 1)
      beta: 1,
    };
  }

  private updateLatencyBuffer(modelId: string, operation: string, latencyMs: number): void {
    const key = `${operation}:${modelId}`;
    
    if (!this.latencyBuffer.has(key)) {
      this.latencyBuffer.set(key, []);
    }
    
    const buffer = this.latencyBuffer.get(key)!;
    buffer.push(latencyMs);
    
    // Keep only last N samples
    if (buffer.length > this.MAX_LATENCY_SAMPLES) {
      buffer.shift();
    }
  }

  /**
   * Get latency percentiles for a model/operation
   */
  getLatencyPercentiles(modelId: string, operation: string): {
    p50: number;
    p95: number;
    p99: number;
  } | null {
    const key = `${operation}:${modelId}`;
    const buffer = this.latencyBuffer.get(key);
    
    if (!buffer || buffer.length === 0) {
      return null;
    }
    
    const sorted = [...buffer].sort((a, b) => a - b);
    const len = sorted.length;
    
    return {
      p50: sorted[Math.floor(len * 0.50)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
    };
  }

  /**
   * Get aggregate metrics for dashboard
   */
  async getAggregateMetrics(): Promise<{
    totalModelsTracked: number;
    totalCalls: number;
    totalTokens: number;
    totalCost: number;
    avgSuccessRate: number;
    topOperations: Array<{ operation: string; calls: number }>;
  }> {
    const allKeys = await this.kv.list({ prefix: 'quality:' });
    
    let totalModelsTracked = 0;
    let totalCalls = 0;
    let totalTokens = 0;
    let totalCost = 0;
    let successSum = 0;
    const operationCalls: Map<string, number> = new Map();
    
    for (const key of allKeys.keys) {
      const data = await this.kv.get(key.name);
      if (data) {
        try {
          const stats = JSON.parse(data) as ModelQualityStats;
          totalModelsTracked++;
          const calls = stats.successes + stats.failures;
          totalCalls += calls;
          totalTokens += stats.totalTokens;
          totalCost += stats.totalCost;
          successSum += stats.successRate * calls;
          
          const current = operationCalls.get(stats.operation) || 0;
          operationCalls.set(stats.operation, current + calls);
        } catch {
          // Skip invalid
        }
      }
    }
    
    const topOperations = Array.from(operationCalls.entries())
      .map(([operation, calls]) => ({ operation, calls }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 10);
    
    return {
      totalModelsTracked,
      totalCalls,
      totalTokens,
      totalCost,
      avgSuccessRate: totalCalls > 0 ? successSum / totalCalls : 0,
      topOperations,
    };
  }
}
