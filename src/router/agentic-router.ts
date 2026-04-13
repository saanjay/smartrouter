/**
 * Agentic AI Router v2.0
 * 
 * Core routing logic with:
 * - Free-first tier selection
 * - Thompson Sampling for intelligent exploration (v2.0)
 * - Circuit Breaker pattern for resilience (v2.0)
 * - Quality Feedback Loop for model learning (v2.0)
 * - Random shuffle within tier (rate limit distribution)
 * - KV-backed cooldowns (global coordination)
 * - Automatic tier escalation on exhaustion
 * - Dynamic model discovery (refreshed every 24h)
 * - Semantic caching (exact + vector similarity)
 * - Performance tracking and model degradation detection
 * - Budget guards with daily/monthly limits
 * - Actual cost tracking from OpenRouter response (v2.0)
 */

/// <reference types="@cloudflare/workers-types" />

import type { 
  Operation, 
  Modality,
  Tier,
  TaskSpec,
  ChatRequest, 
  RouteResult,
  RouterConfig,
  ModelProfile,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { 
  DynamicModelRegistry,
  getModelsForOperation, 
  getTierOrder, 
  ULTIMATE_FALLBACK,
  getModelById,
  OPERATION_CONFIG,
} from './model-registry';
import { CooldownManager } from './cooldown-manager';
import { HealthTracker, type ServiceHealth } from './health-tracker';
import { PerformanceTracker } from './performance-tracker';
import { BudgetGuard } from './budget-guard';
import { QualityTracker, type QualitySignal } from './quality-tracker';
import { CircuitBreaker } from './circuit-breaker';
import { SemanticCache, type CacheStats } from '../cache/semantic-cache';
import { shuffle } from '../utils/shuffle';

// =============================================================================
// Environment Interface
// =============================================================================

export interface RouterEnv {
  MODEL_STATE: KVNamespace;
  AI_GATEWAY_ENDPOINT: string;
  AI_GATEWAY_TOKEN: string;
  AI?: Ai;                        // Workers AI for embeddings (optional)
  RESPONSE_CACHE_INDEX?: VectorizeIndex; // Vector index for semantic cache (optional)
}

// =============================================================================
// Agentic Router
// =============================================================================

export class AgenticRouter {
  private cooldownManager: CooldownManager;
  private healthTracker: HealthTracker;
  private performanceTracker: PerformanceTracker;
  private budgetGuard: BudgetGuard;
  private qualityTracker: QualityTracker;      // v2.0: Thompson Sampling
  private circuitBreaker: CircuitBreaker;       // v2.0: Resilience
  private semanticCache: SemanticCache | null = null;
  private config: RouterConfig;
  private env: RouterEnv;
  private registry: DynamicModelRegistry = new DynamicModelRegistry();
  private initialized = false;

  constructor(env: RouterEnv, config: RouterConfig = DEFAULT_CONFIG) {
    this.env = env;
    this.config = config;
    this.cooldownManager = new CooldownManager(env.MODEL_STATE, config);
    this.healthTracker = new HealthTracker(env.MODEL_STATE);
    this.performanceTracker = new PerformanceTracker(env.MODEL_STATE);
    this.budgetGuard = new BudgetGuard(env.MODEL_STATE, {
      dailyLimitUsd: config.dailyCostCapUsd || 50,
    });
    // v2.0: Quality tracking with Thompson Sampling
    this.qualityTracker = new QualityTracker(env.MODEL_STATE);
    // v2.0: Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker(env.MODEL_STATE, {
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
    });
    
    // Initialize semantic cache if AI binding available
    if (env.AI) {
      this.semanticCache = new SemanticCache(
        env.MODEL_STATE,
        env.AI,
        env.RESPONSE_CACHE_INDEX || null,
        { enabled: true }
      );
    }
  }

  /**
   * Initialize the router (load models from KV)
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.registry.init(this.env.MODEL_STATE);
    this.initialized = true;
    console.log(`[Router] Initialized with ${this.registry.getModelCount()} models`);
  }

  /**
   * Route a chat request to the best available model
   */
  async route(
    operation: Operation,
    request: ChatRequest
  ): Promise<RouteResult> {
    // Ensure initialized
    await this.init();
    
    const startTime = Date.now();
    const opConfig = OPERATION_CONFIG[operation];
    const modelsAttempted: string[] = [];
    let retryCount = 0;
    
    console.log(`[Router] Operation: ${operation} | Capabilities: ${opConfig.requiredCapabilities.join(', ')}`);

    // === STEP 1: Check semantic cache (if enabled) ===
    if (this.semanticCache && opConfig.enableCache !== false && !request.skipCache) {
      const promptText = request.messages.map(m => m.content).join('\n');
      const cacheResult = await this.semanticCache.get(promptText, operation);
      
      if (cacheResult.hit && cacheResult.response) {
        console.log(`[Router] Cache HIT (${cacheResult.level}) - saved ${cacheResult.response.tokens.total} tokens`);
        return {
          success: true,
          model: cacheResult.response.model,
          tier: 'free' as Tier,  // Cache is effectively free
          content: cacheResult.response.content,
          tokens: cacheResult.response.tokens,
          latencyMs: Date.now() - startTime,
          cached: true,
          cacheLevel: cacheResult.level,
          estimatedCost: 0,
        };
      }
    }

    // === STEP 2: Check budget guards ===
    const budgetCheck = await this.budgetGuard.preCheck(0.001); // Estimate ~$0.001 per request
    if (!budgetCheck.allowed) {
      console.log(`[Router] Budget guard blocked: ${budgetCheck.reason}`);
      return {
        success: false,
        model: 'none',
        tier: 'free',
        content: '',
        tokens: { prompt: 0, completion: 0, total: 0 },
        latencyMs: Date.now() - startTime,
        cached: false,
        error: `Budget limit exceeded: ${budgetCheck.reason}`,
      };
    }

    // === STEP 3: Determine tier order ===
    // Check if operation or request forces free-only
    const forceFreeOnly = opConfig.forceFreeOnly || request.forceFreeOnly || budgetCheck.freeOnlyMode;
    
    // Get exploration rate from operation config or defaults
    const explorationRate = opConfig.explorationRate ?? this.config.cheapExplorationRate;
    const shouldExploreCheap = !forceFreeOnly && Math.random() < explorationRate;
    const shouldExplorePremium = !forceFreeOnly && Math.random() < this.config.premiumExplorationRate;

    // Build tier order based on exploration and constraints
    let tierOrder: Tier[];
    if (forceFreeOnly) {
      tierOrder = ['free'];
      console.log(`[Router] Free-only mode active`);
    } else {
      tierOrder = this.buildTierOrder(shouldExploreCheap, shouldExplorePremium);
    }
    
    console.log(`[Router] Tier order: ${tierOrder.join(' → ')} | Explore: cheap=${shouldExploreCheap}, premium=${shouldExplorePremium}`);

    // === STEP 4: Try each tier ===
    for (const tier of tierOrder) {
      const result = await this.tryTier(tier, operation, request, startTime, modelsAttempted);
      if (result) {
        // Store in cache for future requests
        if (this.semanticCache && opConfig.enableCache !== false && result.success) {
          const promptText = request.messages.map(m => m.content).join('\n');
          await this.semanticCache.set(promptText, operation, {
            content: result.content,
            model: result.model,
            tokens: result.tokens,
          });
        }
        
        // Record cost in budget
        if (result.estimatedCost && result.estimatedCost > 0) {
          await this.budgetGuard.recordCost({
            amount: result.estimatedCost,
            modelId: result.model,
            operation,
            tokens: result.tokens.total,
          });
        }
        
        // Add tracking metadata
        result.retryCount = retryCount;
        result.modelsAttempted = modelsAttempted;
        
        return result;
      }
      retryCount++;
    }

    // All tiers exhausted - try ultimate fallback
    console.log(`[Router] All tiers exhausted, trying ultimate fallback: ${ULTIMATE_FALLBACK}`);
    
    try {
      const result = await this.callModel(ULTIMATE_FALLBACK, request, startTime);
      return {
        ...result,
        model: ULTIMATE_FALLBACK,
        tier: 'cheap',
      };
    } catch (error: any) {
      // Ultimate fallback failed - return error
      return {
        success: false,
        model: ULTIMATE_FALLBACK,
        tier: 'cheap',
        content: '',
        tokens: { prompt: 0, completion: 0, total: 0 },
        latencyMs: Date.now() - startTime,
        cached: false,
        error: `All models failed. Last error: ${error.message}`,
      };
    }
  }

  /**
   * Try all models in a tier (v2.0: with circuit breaker + quality tracking)
   */
  private async tryTier(
    tier: Tier,
    operation: Operation,
    request: ChatRequest,
    startTime: number,
    modelsAttempted: string[] = []
  ): Promise<RouteResult | null> {
    // Get models for this operation and tier
    const models = getModelsForOperation(this.registry, operation, tier);
    
    if (models.length === 0) {
      console.log(`[Router] No models for ${operation} in ${tier} tier`);
      return null;
    }

    // Filter to available models (not on cooldown)
    const modelIds = models.map(m => m.id);
    const availableIds = await this.cooldownManager.filterAvailable(modelIds);

    if (availableIds.length === 0) {
      console.log(`[Router] All ${tier} models on cooldown`);
      return null;
    }

    // v2.0: Filter out models with open circuits
    const circuitAvailableIds: string[] = [];
    for (const modelId of availableIds) {
      const circuitStatus = await this.circuitBreaker.canRequest(modelId);
      if (circuitStatus.allowed) {
        circuitAvailableIds.push(modelId);
      } else {
        console.log(`[Router] Circuit open for ${modelId}: ${circuitStatus.reason}`);
      }
    }

    if (circuitAvailableIds.length === 0) {
      console.log(`[Router] All ${tier} models have open circuits`);
      return null;
    }

    // v2.0: Use Thompson Sampling for intelligent ordering instead of random shuffle
    const tierMap = new Map(models.map(m => [m.id, m.tier]));
    const rankedModels = await this.qualityTracker.getRankedModels(operation, circuitAvailableIds, tierMap);
    const orderedIds = rankedModels.map(r => r.modelId);
    
    console.log(`[Router] Tier ${tier}: ${orderedIds.length}/${models.length} available (Thompson Sampling ordered)`);

    // Get operation-specific retry count or default
    const opConfig = OPERATION_CONFIG[operation];
    const maxRetries = Math.min(orderedIds.length, opConfig.maxRetries ?? this.config.maxRetriesPerTier);
    
    for (let i = 0; i < maxRetries; i++) {
      const modelId = orderedIds[i];
      modelsAttempted.push(modelId);
      
      try {
        console.log(`[Router] Trying: ${modelId} (${i + 1}/${maxRetries})`);
        
        const result = await this.callModel(modelId, request, startTime);
        
        console.log(`[Router] ✅ Success: ${modelId} | ${result.latencyMs}ms | cached=${result.cached}`);
        
        // Track success in health metrics
        await this.healthTracker.recordSuccess(modelId);
        
        // v2.0: Record quality signal for Thompson Sampling
        await this.qualityTracker.recordSignal({
          modelId,
          operation,
          success: true,
          latencyMs: result.latencyMs,
          tokens: result.tokens.total,
          cost: result.estimatedCost || 0,
        });
        
        // v2.0: Record success in circuit breaker
        await this.circuitBreaker.recordSuccess(modelId);
        
        // Track performance metrics
        await this.performanceTracker.record({
          modelId,
          operation,
          success: true,
          latencyMs: result.latencyMs,
          inputTokens: result.tokens.prompt,
          outputTokens: result.tokens.completion,
          estimatedCost: result.estimatedCost || 0,
        });
        
        return {
          ...result,
          model: modelId,
          tier,
        };
        
      } catch (error: any) {
        const status = error.status || 500;
        
        console.log(`[Router] ❌ Failed: ${modelId} | ${status} | ${error.message}`);
        
        // Track failure and get progressive cooldown multiplier
        const cooldownMultiplier = await this.healthTracker.recordFailure(modelId, status, error.message);
        
        // v2.0: Record quality signal for Thompson Sampling
        await this.qualityTracker.recordSignal({
          modelId,
          operation,
          success: false,
          latencyMs: Date.now() - startTime,
          tokens: 0,
          cost: 0,
          errorCode: status,
          errorMessage: error.message?.substring(0, 100),
        });
        
        // v2.0: Record failure in circuit breaker
        await this.circuitBreaker.recordFailure(modelId, status);
        
        // Track performance metrics for failure
        await this.performanceTracker.record({
          modelId,
          operation,
          success: false,
          latencyMs: Date.now() - startTime,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCost: 0,
          errorCode: status,
        });
        
        // Apply cooldown based on error type with progressive multiplier
        await this.handleFailure(modelId, status, error.message, cooldownMultiplier);
      }
    }

    return null;
  }

  /**
   * Call a model via AI Gateway
   */
  private async callModel(
    modelId: string,
    request: ChatRequest,
    startTime: number
  ): Promise<Omit<RouteResult, 'model' | 'tier'>> {
    const response = await fetch(
      `${this.env.AI_GATEWAY_ENDPOINT}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
          'cf-aig-cache-ttl': request.skipCache ? '0' : '3600',
          'cf-aig-metadata': JSON.stringify({
            service: 'smart-router',
            operation: 'chat',
            model: modelId,
          }),
        },
        body: JSON.stringify({
          model: modelId,
          messages: request.messages,
          temperature: request.temperature ?? 0.1,
          max_tokens: request.maxTokens ?? 4000,
          // OpenRouter recommended: user ID for abuse detection
          user: request.metadata?.userId || request.metadata?.tenantId || 'system',
          // Structured output for operations that need JSON
          ...(request.responseFormat && { response_format: request.responseFormat }),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      const error = new Error(`API error ${response.status}: ${errorText}`);
      (error as any).status = response.status;
      throw error;
    }

    const data = await response.json() as any;
    const latencyMs = Date.now() - startTime;
    const cached = response.headers.get('cf-aig-cache-status') === 'HIT';

    // Get actual cost from OpenRouter response (preferred) or estimate
    // OpenRouter returns cost in the usage object for some providers
    let actualCost = 0;
    if (data.usage?.cost) {
      // OpenRouter provides actual cost in some responses
      actualCost = data.usage.cost;
    } else if (data.usage?.total_cost) {
      // Alternative field name
      actualCost = data.usage.total_cost;
    } else {
      // Fallback to estimation
      const modelProfile = getModelById(this.registry, modelId);
      actualCost = this.estimateCost(modelProfile, data.usage);
    }

    // Log actual cost for analytics (v2.0 enhancement)
    console.log(`[Router] Model: ${modelId} | Tokens: ${data.usage?.total_tokens || 0} | Cost: $${actualCost.toFixed(6)} | Latency: ${latencyMs}ms | Cached: ${cached}`);

    return {
      success: true,
      content: data.choices?.[0]?.message?.content || '',
      tokens: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
      latencyMs,
      cached,
      estimatedCost: actualCost,
    };
  }

  /**
   * Handle a model failure - apply cooldown
   */
  private async handleFailure(
    modelId: string,
    status: number,
    message: string,
    cooldownMultiplier: number = 1
  ): Promise<void> {
    // Don't cooldown the ultimate fallback
    if (modelId === ULTIMATE_FALLBACK) {
      console.log(`[Router] Not cooling down ultimate fallback: ${modelId}`);
      return;
    }

    let reason: string;
    
    switch (status) {
      case 429:
        reason = `Rate limited (${cooldownMultiplier}x cooldown)`;
        break;
      case 404:
        reason = 'Model not found - check registry';
        break;
      case 503:
        reason = 'Service unavailable';
        break;
      default:
        reason = `Error ${status}: ${message.substring(0, 100)}`;
    }

    // Apply progressive cooldown
    await this.cooldownManager.setCooldown(modelId, reason, status, cooldownMultiplier);
  }

  /**
   * Build tier order based on exploration flags
   */
  private buildTierOrder(
    exploreCheap: boolean,
    explorePremium: boolean
  ): Tier[] {
    // Standard order: free → cheap → premium
    const order: Tier[] = ['free', 'cheap', 'premium'];

    // If exploring premium, put it first (rare)
    if (explorePremium) {
      return ['premium', 'free', 'cheap'];
    }

    // If exploring cheap, interleave it
    if (exploreCheap) {
      return ['cheap', 'free', 'premium'];
    }

    return order;
  }

  /**
   * Estimate cost based on token usage
   */
  private estimateCost(
    profile: ModelProfile | undefined,
    usage: { prompt_tokens?: number; completion_tokens?: number }
  ): number {
    if (!profile || profile.tier === 'free') return 0;

    // Rough cost estimates per 1M tokens
    const costPer1M: Record<Tier, { input: number; output: number }> = {
      free: { input: 0, output: 0 },
      cheap: { input: 0.15, output: 0.60 },
      premium: { input: 2.50, output: 10.00 },
    };

    const rates = costPer1M[profile.tier];
    const promptCost = ((usage.prompt_tokens || 0) / 1_000_000) * rates.input;
    const completionCost = ((usage.completion_tokens || 0) / 1_000_000) * rates.output;

    return promptCost + completionCost;
  }

  /**
   * Get current cooldown status (for debugging)
   */
  async getCooldownStatus(): Promise<Record<string, any>> {
    return this.cooldownManager.getCooldownStatus();
  }

  /**
   * Clear all cooldowns (for recovery)
   */
  async clearAllCooldowns(): Promise<void> {
    const status = await this.getCooldownStatus();
    for (const modelId of Object.keys(status)) {
      await this.cooldownManager.clearCooldown(modelId);
    }
    // Also reset health tracker failures
    await this.healthTracker.resetModelFailures();
    console.log(`[Router] Cleared ${Object.keys(status).length} cooldowns and reset health metrics`);
  }

  /**
   * Get comprehensive service health status
   */
  async getServiceHealth(): Promise<ServiceHealth> {
    await this.init();
    
    const totalModels = this.registry.getModelCount();
    const cooldowns = await this.getCooldownStatus();
    const modelsOnCooldown = Object.keys(cooldowns).length;
    
    return this.healthTracker.calculateHealth(totalModels, modelsOnCooldown);
  }

  /**
   * Check if service has minimum viable routing capacity
   */
  async hasMinimumCapacity(): Promise<{ viable: boolean; reason?: string }> {
    await this.init();
    
    const totalModels = this.registry.getModelCount();
    const cooldowns = await this.getCooldownStatus();
    const available = totalModels - Object.keys(cooldowns).length;
    
    return this.healthTracker.hasMinimumCapacity(available);
  }

  /**
   * Get health metrics (for debugging)
   */
  async getHealthMetrics() {
    return this.healthTracker.getMetrics();
  }

  // ===========================================================================
  // New Optimization Methods
  // ===========================================================================

  /**
   * Get cache statistics
   */
  getCacheStats(): CacheStats | null {
    return this.semanticCache?.getStats() || null;
  }

  /**
   * Get budget status
   */
  async getBudgetStatus() {
    return this.budgetGuard.getStatus();
  }

  /**
   * Get performance metrics for a model/operation
   */
  async getPerformanceMetrics(modelId: string, operation: Operation) {
    return this.performanceTracker.getMetrics(modelId, operation);
  }

  /**
   * Get best performing models for an operation
   */
  async getBestModels(operation: Operation, count: number = 5) {
    return this.performanceTracker.getBestModels(operation, count);
  }

  /**
   * Check if a model is degraded based on performance
   */
  async isModelDegraded(modelId: string, operation: Operation) {
    return this.performanceTracker.isModelDegraded(modelId, operation);
  }

  /**
   * Reset free-only mode (admin override)
   */
  async resetBudgetMode() {
    await this.budgetGuard.resetFreeOnlyMode();
  }

  /**
   * Get spending history
   */
  async getSpendingHistory(days: number = 7) {
    return this.budgetGuard.getSpendingHistory(days);
  }

  /**
   * Clear semantic cache
   */
  async clearCache() {
    if (this.semanticCache) {
      return this.semanticCache.clearAll();
    }
    return { deleted: 0 };
  }

  /**
   * Get comprehensive router stats
   */
  async getRouterStats() {
    await this.init();
    
    const [health, budget, cooldowns, cacheStats, perfStats] = await Promise.all([
      this.getServiceHealth(),
      this.getBudgetStatus(),
      this.getCooldownStatus(),
      Promise.resolve(this.getCacheStats()),
      this.performanceTracker.getOverallStats(),
    ]);

    return {
      models: {
        total: this.registry.getModelCount(),
        onCooldown: Object.keys(cooldowns).length,
      },
      health,
      budget,
      cache: cacheStats,
      performance: perfStats,
    };
  }

  // ===========================================================================
  // v2.0 Methods: Quality Tracking & Circuit Breaker
  // ===========================================================================

  /**
   * Get aggregate quality metrics
   */
  async getQualityMetrics() {
    return this.qualityTracker.getAggregateMetrics();
  }

  /**
   * Get quality stats for a specific operation
   */
  async getQualityStatsForOperation(operation: string) {
    return this.qualityTracker.getAllStatsForOperation(operation);
  }

  /**
   * Get top performing models for an operation
   */
  async getTopQualityModels(operation: string, limit: number = 10) {
    return this.qualityTracker.getTopModels(operation, limit);
  }

  /**
   * Get circuit breaker statistics
   */
  async getCircuitBreakerStats() {
    return this.circuitBreaker.getStats();
  }

  /**
   * Get all open circuits
   */
  async getOpenCircuits() {
    return this.circuitBreaker.getOpenCircuits();
  }

  /**
   * Force close a circuit (admin action)
   */
  async forceCloseCircuit(modelId: string) {
    return this.circuitBreaker.forceClose(modelId);
  }

  /**
   * Force open a circuit (for maintenance)
   */
  async forceOpenCircuit(modelId: string) {
    return this.circuitBreaker.forceOpen(modelId);
  }

  /**
   * Check if a model should be avoided based on quality
   */
  async shouldAvoidModel(modelId: string, operation: Operation) {
    return this.qualityTracker.shouldAvoidModel(modelId, operation);
  }

  /**
   * Get problematic models for an operation
   */
  async getProblematicModels(operation: string, minCalls: number = 10, maxErrorRate: number = 0.20) {
    return this.qualityTracker.getProblematicModels(operation, minCalls, maxErrorRate);
  }
}
