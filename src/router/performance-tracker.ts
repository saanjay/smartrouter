/**
 * Model Performance Tracker
 * 
 * Tracks actual runtime performance of models:
 * - Success rates
 * - Latency (P50, P95, P99)
 * - Quality scores
 * - Cost per successful request
 * 
 * Uses this data to improve model selection over static benchmarks.
 */

/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// Types
// =============================================================================

export interface PerformanceMetrics {
  modelId: string;
  operation: string;
  
  // Request counts
  totalRequests: number;
  successCount: number;
  failureCount: number;
  
  // Success rate
  successRate: number;
  
  // Latency (milliseconds)
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  
  // Token usage
  avgInputTokens: number;
  avgOutputTokens: number;
  
  // Cost efficiency
  avgCostPerRequest: number;
  costPerSuccessfulRequest: number;
  
  // Time tracking
  firstSeen: number;
  lastSeen: number;
  lastUpdated: number;
}

export interface PerformanceEntry {
  modelId: string;
  operation: string;
  success: boolean;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  errorCode?: number;
  timestamp: number;
}

export interface PerformanceTrackerConfig {
  enabled: boolean;
  maxEntriesPerModel: number;      // Rolling window size
  persistIntervalMs: number;       // How often to persist to KV
  decayFactorPerDay: number;       // Weight decay for old data (0.9 = 10% decay/day)
}

const DEFAULT_CONFIG: PerformanceTrackerConfig = {
  enabled: true,
  maxEntriesPerModel: 100,         // Last 100 requests per model
  persistIntervalMs: 60000,        // 1 minute
  decayFactorPerDay: 0.95,         // 5% decay per day
};

// =============================================================================
// Performance Tracker Class
// =============================================================================

export class PerformanceTracker {
  private kv: KVNamespace;
  private config: PerformanceTrackerConfig;
  
  // In-memory buffer (persisted periodically)
  private entries: Map<string, PerformanceEntry[]> = new Map();
  private metrics: Map<string, PerformanceMetrics> = new Map();
  private lastPersist: number = 0;
  private dirty: Set<string> = new Set();

  constructor(kv: KVNamespace, config: Partial<PerformanceTrackerConfig> = {}) {
    this.kv = kv;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Recording Methods
  // ===========================================================================

  /**
   * Record a model request result
   */
  async record(entry: Omit<PerformanceEntry, 'timestamp'>): Promise<void> {
    if (!this.config.enabled) return;

    const fullEntry: PerformanceEntry = {
      ...entry,
      timestamp: Date.now(),
    };

    const key = this.getKey(entry.modelId, entry.operation);
    
    // Get or create entries array
    let modelEntries = this.entries.get(key);
    if (!modelEntries) {
      // Try to load from KV
      modelEntries = await this.loadEntries(key);
      this.entries.set(key, modelEntries);
    }

    // Add new entry (rolling window)
    modelEntries.push(fullEntry);
    if (modelEntries.length > this.config.maxEntriesPerModel) {
      modelEntries.shift(); // Remove oldest
    }

    // Recalculate metrics
    this.updateMetrics(key, modelEntries);
    
    // Mark for persistence
    this.dirty.add(key);

    // Persist if enough time has passed
    if (Date.now() - this.lastPersist > this.config.persistIntervalMs) {
      await this.persist();
    }
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get performance metrics for a model+operation
   */
  async getMetrics(modelId: string, operation: string): Promise<PerformanceMetrics | null> {
    const key = this.getKey(modelId, operation);
    
    // Check in-memory first
    let metrics = this.metrics.get(key);
    if (metrics) return metrics;

    // Try to load from KV
    const stored = await this.kv.get(`perf:metrics:${key}`);
    if (stored) {
      metrics = JSON.parse(stored) as PerformanceMetrics;
      this.metrics.set(key, metrics);
      return metrics;
    }

    return null;
  }

  /**
   * Get all metrics for an operation (across all models)
   */
  async getMetricsForOperation(operation: string): Promise<PerformanceMetrics[]> {
    const results: PerformanceMetrics[] = [];
    
    // Get from in-memory cache
    for (const [key, metrics] of this.metrics) {
      if (key.endsWith(`:${operation}`)) {
        results.push(metrics);
      }
    }

    // Also check KV for any we missed
    const list = await this.kv.list({ prefix: `perf:metrics:` });
    for (const item of list.keys) {
      if (item.name.endsWith(`:${operation}`)) {
        const key = item.name.replace('perf:metrics:', '');
        if (!this.metrics.has(key)) {
          const stored = await this.kv.get(item.name);
          if (stored) {
            const metrics = JSON.parse(stored) as PerformanceMetrics;
            results.push(metrics);
          }
        }
      }
    }

    return results;
  }

  /**
   * Get best performing models for an operation
   */
  async getBestModels(
    operation: string,
    count: number = 5,
    sortBy: 'successRate' | 'latency' | 'cost' = 'successRate'
  ): Promise<PerformanceMetrics[]> {
    const allMetrics = await this.getMetricsForOperation(operation);
    
    // Filter models with sufficient data
    const qualified = allMetrics.filter(m => m.totalRequests >= 10);
    
    // Sort by specified criteria
    switch (sortBy) {
      case 'successRate':
        qualified.sort((a, b) => b.successRate - a.successRate);
        break;
      case 'latency':
        qualified.sort((a, b) => a.p50LatencyMs - b.p50LatencyMs);
        break;
      case 'cost':
        qualified.sort((a, b) => a.costPerSuccessfulRequest - b.costPerSuccessfulRequest);
        break;
    }

    return qualified.slice(0, count);
  }

  /**
   * Check if a model is performing poorly
   */
  async isModelDegraded(
    modelId: string,
    operation: string,
    thresholds: { minSuccessRate?: number; maxLatencyMs?: number } = {}
  ): Promise<boolean> {
    const { minSuccessRate = 0.90, maxLatencyMs = 10000 } = thresholds;
    
    const metrics = await this.getMetrics(modelId, operation);
    if (!metrics || metrics.totalRequests < 5) {
      return false; // Not enough data to judge
    }

    if (metrics.successRate < minSuccessRate) {
      console.log(`[PerfTracker] ${modelId} degraded: success rate ${(metrics.successRate * 100).toFixed(1)}%`);
      return true;
    }

    if (metrics.p95LatencyMs > maxLatencyMs) {
      console.log(`[PerfTracker] ${modelId} degraded: P95 latency ${metrics.p95LatencyMs}ms`);
      return true;
    }

    return false;
  }

  // ===========================================================================
  // Metrics Calculation
  // ===========================================================================

  private updateMetrics(key: string, entries: PerformanceEntry[]): void {
    if (entries.length === 0) return;

    const now = Date.now();
    const modelId = entries[0].modelId;
    const operation = entries[0].operation;

    // Apply time decay weights
    const weightedEntries = entries.map(e => ({
      ...e,
      weight: this.calculateWeight(e.timestamp, now),
    }));

    const totalWeight = weightedEntries.reduce((sum, e) => sum + e.weight, 0);
    
    // Calculate success rate
    const successWeight = weightedEntries
      .filter(e => e.success)
      .reduce((sum, e) => sum + e.weight, 0);
    const successRate = totalWeight > 0 ? successWeight / totalWeight : 0;

    // Calculate latencies
    const latencies = entries.map(e => e.latencyMs).sort((a, b) => a - b);
    const avgLatencyMs = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
    const p50LatencyMs = this.percentile(latencies, 50);
    const p95LatencyMs = this.percentile(latencies, 95);
    const p99LatencyMs = this.percentile(latencies, 99);

    // Calculate token usage
    const avgInputTokens = entries.reduce((sum, e) => sum + e.inputTokens, 0) / entries.length;
    const avgOutputTokens = entries.reduce((sum, e) => sum + e.outputTokens, 0) / entries.length;

    // Calculate cost
    const totalCost = entries.reduce((sum, e) => sum + e.estimatedCost, 0);
    const avgCostPerRequest = totalCost / entries.length;
    const successfulEntries = entries.filter(e => e.success);
    const costPerSuccessfulRequest = successfulEntries.length > 0
      ? successfulEntries.reduce((sum, e) => sum + e.estimatedCost, 0) / successfulEntries.length
      : 0;

    const metrics: PerformanceMetrics = {
      modelId,
      operation,
      totalRequests: entries.length,
      successCount: entries.filter(e => e.success).length,
      failureCount: entries.filter(e => !e.success).length,
      successRate,
      avgLatencyMs,
      p50LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
      avgInputTokens,
      avgOutputTokens,
      avgCostPerRequest,
      costPerSuccessfulRequest,
      firstSeen: Math.min(...entries.map(e => e.timestamp)),
      lastSeen: Math.max(...entries.map(e => e.timestamp)),
      lastUpdated: now,
    };

    this.metrics.set(key, metrics);
  }

  private calculateWeight(timestamp: number, now: number): number {
    const daysAgo = (now - timestamp) / (24 * 60 * 60 * 1000);
    return Math.pow(this.config.decayFactorPerDay, daysAgo);
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  // ===========================================================================
  // Persistence
  // ===========================================================================

  private async loadEntries(key: string): Promise<PerformanceEntry[]> {
    try {
      const stored = await this.kv.get(`perf:entries:${key}`);
      if (stored) {
        return JSON.parse(stored) as PerformanceEntry[];
      }
    } catch {
      // Ignore parse errors
    }
    return [];
  }

  async persist(): Promise<void> {
    for (const key of this.dirty) {
      const entries = this.entries.get(key);
      const metrics = this.metrics.get(key);
      
      if (entries) {
        await this.kv.put(`perf:entries:${key}`, JSON.stringify(entries), {
          expirationTtl: 86400 * 7, // 7 days
        });
      }
      
      if (metrics) {
        await this.kv.put(`perf:metrics:${key}`, JSON.stringify(metrics), {
          expirationTtl: 86400 * 30, // 30 days
        });
      }
    }
    
    this.dirty.clear();
    this.lastPersist = Date.now();
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  private getKey(modelId: string, operation: string): string {
    return `${modelId}:${operation}`;
  }

  /**
   * Get overall stats
   */
  async getOverallStats(): Promise<{
    modelsTracked: number;
    totalRequests: number;
    avgSuccessRate: number;
    topModels: Array<{ modelId: string; successRate: number; requests: number }>;
  }> {
    const allMetrics = Array.from(this.metrics.values());
    
    const totalRequests = allMetrics.reduce((sum, m) => sum + m.totalRequests, 0);
    const avgSuccessRate = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + m.successRate, 0) / allMetrics.length
      : 0;

    const topModels = allMetrics
      .filter(m => m.totalRequests >= 10)
      .sort((a, b) => b.successRate - a.successRate)
      .slice(0, 5)
      .map(m => ({
        modelId: m.modelId,
        successRate: m.successRate,
        requests: m.totalRequests,
      }));

    return {
      modelsTracked: allMetrics.length,
      totalRequests,
      avgSuccessRate,
      topModels,
    };
  }
}
