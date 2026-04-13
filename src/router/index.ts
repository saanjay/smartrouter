/**
 * Agentic AI Router - Module Exports
 * 
 * v2.0 Enhancements:
 * - QualityTracker: Thompson Sampling for intelligent model selection
 * - CircuitBreaker: Prevents cascade failures
 * - Enhanced cost tracking and observability
 */

export { AgenticRouter, type RouterEnv } from './agentic-router';
export { CooldownManager } from './cooldown-manager';
export { HealthTracker, type ServiceHealth, type HealthMetrics, type ModelFailureStats } from './health-tracker';
export { PerformanceTracker, type PerformanceMetrics, type PerformanceEntry } from './performance-tracker';
export { BudgetGuard, type BudgetStatus, type BudgetConfig } from './budget-guard';
// v2.0: Quality Tracker with Thompson Sampling
export { 
  QualityTracker, 
  type ModelQualityStats, 
  type QualitySignal, 
  type ModelRanking,
} from './quality-tracker';
// v2.0: Circuit Breaker pattern
export { 
  CircuitBreaker, 
  type CircuitState, 
  type CircuitStatus, 
  type CircuitConfig,
} from './circuit-breaker';
export { 
  DynamicModelRegistry,
  getRegistry,
  OPERATION_CONFIG, 
  ULTIMATE_FALLBACK,
  getModelsForOperation,
  getModelsForCapabilities,
  getModelsByTier,
  getModelById,
  isKnownModel,
  getTierOrder,
} from './model-registry';
export { 
  discoverModels, 
  getActiveModels, 
  getFallbackModels,
  getDiscoveryStatus,
  KV_KEYS,
} from './model-discovery';
export { 
  syncBenchmarks, 
  getLastBenchmarkSync,
  BenchmarkFetcher,
} from './benchmark-fetcher';
export * from './types';
