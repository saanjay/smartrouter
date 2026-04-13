/**
 * AI Router Health Tracker
 * 
 * Tracks service health metrics including:
 * - Request success/failure rates (sliding window)
 * - Per-model failure tracking
 * - Cooldown statistics
 * - Service health score
 * 
 * Uses KV for persistence across Worker isolates.
 */

// =============================================================================
// Types
// =============================================================================

export interface HealthMetrics {
  // Request metrics (last hour, sliding window)
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  
  // Model-specific failures
  modelFailures: Record<string, ModelFailureStats>;
  
  // Timing
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  windowStartedAt: number;
  
  // Calculated
  successRate: number;
  healthScore: number;
  status: 'healthy' | 'degraded' | 'critical';
}

export interface ModelFailureStats {
  consecutiveFailures: number;
  totalFailures: number;
  lastFailureAt: number;
  lastErrorCode: number;
  lastErrorMessage: string;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'critical';
  healthScore: number;          // 0-100
  successRate: number;          // 0-1
  availableModels: number;
  totalModels: number;
  modelsOnCooldown: number;
  lastSuccessAgo: string | null;
  issues: string[];
  recommendations: string[];
}

// =============================================================================
// Constants
// =============================================================================

const HEALTH_KEY = 'health:metrics';
const WINDOW_DURATION_MS = 60 * 60 * 1000; // 1 hour sliding window
const METRICS_TTL_SECONDS = 24 * 60 * 60;  // 24h retention

// Health score thresholds
const DEGRADED_THRESHOLD = 70;
const CRITICAL_THRESHOLD = 40;

// Progressive cooldown multipliers
const COOLDOWN_MULTIPLIERS: Record<number, number> = {
  1: 1,    // First failure: normal cooldown
  2: 2,    // Second: 2x
  3: 4,    // Third: 4x
  4: 8,    // Fourth: 8x
  5: 16,   // Fifth+: 16x (max)
};

// =============================================================================
// Health Tracker Class
// =============================================================================

export class HealthTracker {
  private kv: KVNamespace;
  private metrics: HealthMetrics | null = null;
  private lastFetch = 0;
  private readonly CACHE_TTL_MS = 5000; // 5 second local cache

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  /**
   * Record a successful request
   */
  async recordSuccess(modelId: string): Promise<void> {
    const metrics = await this.getMetrics();
    
    metrics.totalRequests++;
    metrics.successfulRequests++;
    metrics.lastSuccessAt = Date.now();
    
    // Clear consecutive failures for this model
    if (metrics.modelFailures[modelId]) {
      metrics.modelFailures[modelId].consecutiveFailures = 0;
    }
    
    await this.saveMetrics(metrics);
  }

  /**
   * Record a failed request
   */
  async recordFailure(
    modelId: string, 
    errorCode: number, 
    errorMessage: string
  ): Promise<number> {
    const metrics = await this.getMetrics();
    
    metrics.totalRequests++;
    metrics.failedRequests++;
    metrics.lastFailureAt = Date.now();
    
    // Update model-specific failure stats
    if (!metrics.modelFailures[modelId]) {
      metrics.modelFailures[modelId] = {
        consecutiveFailures: 0,
        totalFailures: 0,
        lastFailureAt: 0,
        lastErrorCode: 0,
        lastErrorMessage: '',
      };
    }
    
    const modelStats = metrics.modelFailures[modelId];
    modelStats.consecutiveFailures++;
    modelStats.totalFailures++;
    modelStats.lastFailureAt = Date.now();
    modelStats.lastErrorCode = errorCode;
    modelStats.lastErrorMessage = errorMessage.substring(0, 200);
    
    await this.saveMetrics(metrics);
    
    // Return cooldown multiplier based on consecutive failures
    const multiplier = COOLDOWN_MULTIPLIERS[
      Math.min(modelStats.consecutiveFailures, 5)
    ] || 16;
    
    return multiplier;
  }

  /**
   * Get current health metrics
   */
  async getMetrics(): Promise<HealthMetrics> {
    // Use cached metrics if fresh enough
    if (this.metrics && (Date.now() - this.lastFetch) < this.CACHE_TTL_MS) {
      return this.metrics;
    }
    
    // Fetch from KV
    const stored = await this.kv.get(HEALTH_KEY);
    
    if (stored) {
      try {
        this.metrics = JSON.parse(stored);
        this.lastFetch = Date.now();
        
        // Check if window needs reset
        if (this.metrics && Date.now() - this.metrics.windowStartedAt > WINDOW_DURATION_MS) {
          // Reset window but keep model failures for progressive cooldown
          this.metrics = this.resetWindow(this.metrics);
        }
        
        return this.metrics!;
      } catch (e) {
        console.error('[HealthTracker] Failed to parse metrics:', e);
      }
    }
    
    // Initialize fresh metrics
    this.metrics = this.createFreshMetrics();
    this.lastFetch = Date.now();
    return this.metrics;
  }

  /**
   * Calculate comprehensive service health
   */
  async calculateHealth(
    totalModels: number,
    modelsOnCooldown: number
  ): Promise<ServiceHealth> {
    const metrics = await this.getMetrics();
    const issues: string[] = [];
    const recommendations: string[] = [];
    
    // Calculate success rate
    const successRate = metrics.totalRequests > 0
      ? metrics.successfulRequests / metrics.totalRequests
      : 1;
    
    // Calculate health score (weighted)
    let healthScore = 100;
    
    // Factor 1: Success rate (40% weight)
    healthScore -= (1 - successRate) * 40;
    
    // Factor 2: Model availability (30% weight)
    const availableModels = totalModels - modelsOnCooldown;
    const modelAvailability = totalModels > 0 
      ? availableModels / totalModels 
      : 0;
    healthScore -= (1 - modelAvailability) * 30;
    
    // Factor 3: Recent failures (20% weight)
    if (metrics.lastFailureAt && metrics.lastSuccessAt) {
      if (metrics.lastFailureAt > metrics.lastSuccessAt) {
        // Most recent action was a failure
        healthScore -= 10;
      }
    }
    
    // Factor 4: Model with high consecutive failures (10% weight)
    const problematicModels = Object.entries(metrics.modelFailures)
      .filter(([, stats]) => stats.consecutiveFailures >= 3);
    if (problematicModels.length > 0) {
      healthScore -= Math.min(problematicModels.length * 2, 10);
      issues.push(`${problematicModels.length} models with 3+ consecutive failures`);
    }
    
    healthScore = Math.max(0, Math.min(100, healthScore));
    
    // Determine status
    let status: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (healthScore < CRITICAL_THRESHOLD) {
      status = 'critical';
      issues.push('Service health is critical');
      recommendations.push('Consider clearing cooldowns and triggering model discovery');
    } else if (healthScore < DEGRADED_THRESHOLD) {
      status = 'degraded';
      issues.push('Service health is degraded');
      recommendations.push('Monitor closely and check model availability');
    }
    
    // Add specific issues
    if (modelsOnCooldown > totalModels * 0.5) {
      issues.push(`${modelsOnCooldown}/${totalModels} models on cooldown`);
      recommendations.push('Check if models are being rate-limited by provider');
    }
    
    if (successRate < 0.8) {
      issues.push(`Low success rate: ${(successRate * 100).toFixed(1)}%`);
    }
    
    if (availableModels < 3) {
      issues.push(`Only ${availableModels} models available`);
      recommendations.push('Consider adding more models to the registry');
    }
    
    // Format last success time
    let lastSuccessAgo: string | null = null;
    if (metrics.lastSuccessAt) {
      const ago = Date.now() - metrics.lastSuccessAt;
      if (ago < 60000) {
        lastSuccessAgo = `${Math.round(ago / 1000)}s ago`;
      } else if (ago < 3600000) {
        lastSuccessAgo = `${Math.round(ago / 60000)}m ago`;
      } else {
        lastSuccessAgo = `${Math.round(ago / 3600000)}h ago`;
      }
    }
    
    return {
      status,
      healthScore: Math.round(healthScore),
      successRate,
      availableModels,
      totalModels,
      modelsOnCooldown,
      lastSuccessAgo,
      issues,
      recommendations,
    };
  }

  /**
   * Get cooldown multiplier for a model based on consecutive failures
   */
  async getCooldownMultiplier(modelId: string): Promise<number> {
    const metrics = await this.getMetrics();
    const failures = metrics.modelFailures[modelId]?.consecutiveFailures || 0;
    return COOLDOWN_MULTIPLIERS[Math.min(failures + 1, 5)] || 16;
  }

  /**
   * Check if service has minimum viable capacity
   */
  async hasMinimumCapacity(
    availableModels: number,
    minimumRequired: number = 1  // Changed from 2 to 1 - single model is acceptable
  ): Promise<{ viable: boolean; reason?: string }> {
    const metrics = await this.getMetrics();
    
    if (availableModels < minimumRequired) {
      return {
        viable: false,
        reason: `Only ${availableModels} models available, need at least ${minimumRequired}`,
      };
    }
    
    // Check if we've had too many recent failures
    if (metrics.totalRequests >= 10 && metrics.failedRequests / metrics.totalRequests > 0.8) {
      return {
        viable: false,
        reason: `High failure rate: ${(metrics.failedRequests / metrics.totalRequests * 100).toFixed(0)}%`,
      };
    }
    
    return { viable: true };
  }

  /**
   * Reset model's consecutive failures (called after manual intervention)
   */
  async resetModelFailures(modelId?: string): Promise<void> {
    const metrics = await this.getMetrics();
    
    if (modelId) {
      delete metrics.modelFailures[modelId];
    } else {
      metrics.modelFailures = {};
    }
    
    await this.saveMetrics(metrics);
  }

  /**
   * Get models sorted by health (least failures first)
   */
  async sortModelsByHealth(modelIds: string[]): Promise<string[]> {
    const metrics = await this.getMetrics();
    
    return [...modelIds].sort((a, b) => {
      const aFailures = metrics.modelFailures[a]?.consecutiveFailures || 0;
      const bFailures = metrics.modelFailures[b]?.consecutiveFailures || 0;
      return aFailures - bFailures;
    });
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private createFreshMetrics(): HealthMetrics {
    return {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      modelFailures: {},
      lastSuccessAt: null,
      lastFailureAt: null,
      windowStartedAt: Date.now(),
      successRate: 1,
      healthScore: 100,
      status: 'healthy',
    };
  }

  private resetWindow(old: HealthMetrics): HealthMetrics {
    // Keep model failures but reset request counts
    // Decay consecutive failures by half to allow recovery
    const decayedFailures: Record<string, ModelFailureStats> = {};
    
    for (const [modelId, stats] of Object.entries(old.modelFailures)) {
      if (stats.consecutiveFailures > 0) {
        decayedFailures[modelId] = {
          ...stats,
          consecutiveFailures: Math.floor(stats.consecutiveFailures / 2),
        };
      }
    }
    
    return {
      ...this.createFreshMetrics(),
      modelFailures: decayedFailures,
    };
  }

  private async saveMetrics(metrics: HealthMetrics): Promise<void> {
    // Recalculate derived fields
    metrics.successRate = metrics.totalRequests > 0
      ? metrics.successfulRequests / metrics.totalRequests
      : 1;
    
    // Simple health score for storage
    metrics.healthScore = Math.round(metrics.successRate * 100);
    metrics.status = metrics.healthScore < CRITICAL_THRESHOLD ? 'critical' 
      : metrics.healthScore < DEGRADED_THRESHOLD ? 'degraded' 
      : 'healthy';
    
    this.metrics = metrics;
    this.lastFetch = Date.now();
    
    await this.kv.put(HEALTH_KEY, JSON.stringify(metrics), {
      expirationTtl: METRICS_TTL_SECONDS,
    });
  }
}
