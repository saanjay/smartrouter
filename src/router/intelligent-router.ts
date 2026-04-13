/**
 * Intelligent AI Router
 * 
 * Main router implementation that combines:
 * - Use case classification
 * - Benchmark-based model selection
 * - Tiered pricing (free-first, cheapest-first)
 * - Automatic fallback and cooldown management
 */

/// <reference types="@cloudflare/workers-types" />

import { UseCaseClassifier, type UseCase, type Complexity, type ClassificationResult } from './use-case-classifier';
import { IntelligentModelSelector, type ModelCandidate, type SelectionResult } from './intelligent-selector';
import type { RouteResult, Tier } from './types';

// Extended ChatRequest with additional fields for intelligent routing
export interface IntelligentChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string | object }>;
  temperature?: number;
  maxTokens?: number;
  skipCache?: boolean;
  responseFormat?: { 
    type: 'json_object' | 'json_schema' | 'text';
    json_schema?: { name: string; schema: any; strict?: boolean };
  };
  plugins?: Array<{ id: string; [key: string]: any }>;
  forceModel?: string;
  metadata?: {
    tenantId?: string;
    userId?: string;
    service?: string;
  };
}

// =============================================================================
// Types
// =============================================================================

export interface IntelligentRouterEnv {
  AI_ROUTER_DB: D1Database;
  MODEL_STATE: KVNamespace;
  AI_GATEWAY_ENDPOINT: string;
  AI_GATEWAY_TOKEN: string;
}

export interface IntelligentRouteResult extends RouteResult {
  classification: ClassificationResult;
  selection: SelectionResult;
}

interface UsageLogEntry {
  request_id: string;
  use_case: string;
  complexity: string;
  prompt_hash?: string;
  model_id: string;
  tier: string;
  benchmark_score: number;
  selection_reason: string;
  tokens_input?: number;
  tokens_output?: number;
  latency_ms: number;
  cost_usd?: number;
  cached: boolean;
  success: boolean;
  error_code?: string;
}

// =============================================================================
// Intelligent Router Class
// =============================================================================

export class IntelligentRouter {
  private classifier: UseCaseClassifier;
  private selector: IntelligentModelSelector;
  private env: IntelligentRouterEnv;
  private initialized: boolean = false;

  constructor(env: IntelligentRouterEnv) {
    this.env = env;
    this.classifier = new UseCaseClassifier(env.AI_ROUTER_DB);
    this.selector = new IntelligentModelSelector(env.AI_ROUTER_DB);
  }

  /**
   * Initialize the router (load config from D1)
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.classifier.loadConfig();
    this.initialized = true;
  }

  /**
   * Select the optimal model for a request without calling it.
   * Used by the /stream endpoint to get the model ID for a streaming call.
   */
  async selectModelForRequest(request: IntelligentChatRequest): Promise<ModelCandidate> {
    await this.initialize();

    const promptText = this.extractPromptText(request.messages);
    const systemPrompt = request.messages.find(m => m.role === 'system')?.content;
    const classification = this.classifier.classify(promptText, systemPrompt as string | undefined);

    if (request.forceModel) {
      return {
        id: request.forceModel,
        provider: request.forceModel.split('/')[0] || 'openai',
        name: request.forceModel,
        input_cost_per_m: 0.15, output_cost_per_m: 0.6,
        context_length: 128000,
        supports_vision: true, supports_function_calling: true, supports_json_mode: true,
        is_free: false, status: 'active',
        bench_humaneval: null, bench_mbpp: null, bench_mmlu: null,
        bench_arc: null, bench_gsm8k: null, bench_math: null,
        bench_ifeval: null, bench_mt_bench: null,
        score_coding: null, score_reasoning: null, score_knowledge: null,
        score_math: null, score_instruction: null, score_creative: null,
        score_overall: 80,
      };
    }

    const qualityThreshold = this.classifier.getQualityThreshold(
      classification.useCase, classification.complexity
    );
    const benchmarkWeights = this.classifier.getBenchmarkWeights(classification.useCase);

    const selection = await this.selector.selectModel({
      useCase: classification.useCase,
      complexity: classification.complexity,
      qualityThreshold,
      benchmarkWeights,
      requireVision: this.requiresVision(request),
      requireJsonMode: request.responseFormat?.type === 'json_object',
    });

    return selection.model;
  }

  /**
   * Route a chat request to the optimal model
   */
  async route(request: IntelligentChatRequest): Promise<IntelligentRouteResult> {
    await this.initialize();

    const startTime = Date.now();
    const requestId = crypto.randomUUID();

    // Extract prompt text for classification
    const promptText = this.extractPromptText(request.messages);
    const systemPrompt = request.messages.find(m => m.role === 'system')?.content;

    // 1. Classify the use case
    const classification = this.classifier.classify(promptText, systemPrompt as string | undefined);

    // Fast path: forceModel bypasses model selection entirely
    if (request.forceModel) {
      const forcedModel: ModelCandidate = {
        id: request.forceModel,
        provider: request.forceModel.split('/')[0] || 'openai',
        name: request.forceModel,
        input_cost_per_m: 0.15,
        output_cost_per_m: 0.6,
        context_length: 128000,
        supports_vision: true,
        supports_function_calling: true,
        supports_json_mode: true,
        is_free: false,
        status: 'active',
        bench_humaneval: null, bench_mbpp: null, bench_mmlu: null,
        bench_arc: null, bench_gsm8k: null, bench_math: null,
        bench_ifeval: null, bench_mt_bench: null,
        score_coding: null, score_reasoning: null, score_knowledge: null,
        score_math: null, score_instruction: null, score_creative: null,
        score_overall: 80,
      };
      const forcedSelection: SelectionResult = {
        model: forcedModel,
        score: 100,
        tier: 'cheap',
        reason: `Forced model: ${request.forceModel}`,
        fallback: false,
      };
      const result = await this.callModel(forcedModel, request, startTime);
      return {
        ...result,
        classification,
        selection: forcedSelection,
      };
    }

    // 2. Get quality threshold for this use case + complexity
    const qualityThreshold = this.classifier.getQualityThreshold(
      classification.useCase, 
      classification.complexity
    );

    // 3. Get benchmark weights for this use case
    const benchmarkWeights = this.classifier.getBenchmarkWeights(classification.useCase);

    // 4. Select optimal model
    const selection = await this.selector.selectModel({
      useCase: classification.useCase,
      complexity: classification.complexity,
      qualityThreshold,
      benchmarkWeights,
      requireVision: this.requiresVision(request),
      requireJsonMode: request.responseFormat?.type === 'json_object',
    });

    // 5. Try the selected model (with fallbacks)
    const result = await this.tryModelWithFallback(
      request, 
      selection, 
      classification,
      startTime,
      requestId
    );

    return {
      ...result,
      classification,
      selection,
    };
  }

  /**
   * Try the selected model, with automatic fallback on failure
   */
  private async tryModelWithFallback(
    request: IntelligentChatRequest,
    selection: SelectionResult,
    classification: ClassificationResult,
    startTime: number,
    requestId: string,
    attemptCount: number = 0
  ): Promise<RouteResult> {
    const maxAttempts = 3;
    
    try {
      const result = await this.callModel(selection.model, request, startTime);
      
      // Log successful usage
      await this.logUsage({
        request_id: requestId,
        use_case: classification.useCase,
        complexity: classification.complexity,
        model_id: selection.model.id,
        tier: selection.tier,
        benchmark_score: selection.score,
        selection_reason: selection.reason,
        tokens_input: result.tokens?.prompt,
        tokens_output: result.tokens?.completion,
        latency_ms: result.latencyMs,
        cached: result.cached || false,
        success: true,
      });

      return result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Log failed attempt
      await this.logUsage({
        request_id: requestId,
        use_case: classification.useCase,
        complexity: classification.complexity,
        model_id: selection.model.id,
        tier: selection.tier,
        benchmark_score: selection.score,
        selection_reason: selection.reason,
        latency_ms: Date.now() - startTime,
        cached: false,
        success: false,
        error_code: errorMessage.slice(0, 100),
      });

      // Apply cooldown to failed model
      await this.applyModelCooldown(selection.model.id, errorMessage);

      // Try fallback if we haven't exceeded max attempts
      if (attemptCount < maxAttempts - 1) {
        const fallbackSelection = await this.selector.selectModel({
          useCase: classification.useCase,
          complexity: classification.complexity,
          qualityThreshold: this.classifier.getQualityThreshold(classification.useCase, classification.complexity) * 0.8, // Lower threshold for fallback
          benchmarkWeights: this.classifier.getBenchmarkWeights(classification.useCase),
          excludeModels: [selection.model.id],
        });

        return this.tryModelWithFallback(
          request,
          fallbackSelection,
          classification,
          startTime,
          requestId,
          attemptCount + 1
        );
      }

      // All attempts failed
      return {
        success: false,
        content: '',
        model: selection.model.id,
        tier: selection.tier as Tier,
        tokens: { prompt: 0, completion: 0, total: 0 },
        cached: false,
        latencyMs: Date.now() - startTime,
        error: `All model attempts failed. Last error: ${errorMessage}`,
      };
    }
  }

  /**
   * Call a model via AI Gateway
   */
  private async callModel(
    model: ModelCandidate,
    request: IntelligentChatRequest,
    startTime: number
  ): Promise<RouteResult> {
    const response = await fetch(
      `${this.env.AI_GATEWAY_ENDPOINT}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
          'cf-aig-cache-ttl': request.skipCache ? '0' : '3600',
          'cf-aig-metadata': JSON.stringify({
            service: 'intelligent-router',
            operation: 'chat',
            model: model.id,
            useCase: 'intelligent-routing',
          }),
        },
        body: JSON.stringify({
          model: model.id,
          messages: request.messages,
          temperature: request.temperature ?? 0.1,
          max_tokens: request.maxTokens ?? 4000,
          ...(request.responseFormat && { response_format: request.responseFormat }),
          ...(request.plugins && { plugins: request.plugins }),
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Model ${model.id} failed: ${response.status} - ${errorText.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      cached?: boolean;
    };

    const latencyMs = Date.now() - startTime;
    const content = data.choices?.[0]?.message?.content || '';
    const tokens = data.usage ? {
      prompt: data.usage.prompt_tokens,
      completion: data.usage.completion_tokens,
      total: data.usage.prompt_tokens + data.usage.completion_tokens,
    } : { prompt: 0, completion: 0, total: 0 };

    // Calculate estimated cost
    const estimatedCost = (
      (tokens.prompt * model.input_cost_per_m / 1_000_000) +
      (tokens.completion * model.output_cost_per_m / 1_000_000)
    );

    return {
      success: true,
      content,
      model: model.id,
      tier: this.mapTier(model),
      tokens,
      cached: data.cached || response.headers.get('cf-cache-status') === 'HIT',
      latencyMs,
      estimatedCost,
    };
  }

  /**
   * Map ModelCandidate to Tier type
   */
  private mapTier(model: ModelCandidate): 'free' | 'cheap' | 'premium' {
    if (model.is_free || model.input_cost_per_m === 0) return 'free';
    if (model.input_cost_per_m < 1) return 'cheap';
    return 'premium';
  }

  /**
   * Apply cooldown to a failed model
   */
  private async applyModelCooldown(modelId: string, error: string): Promise<void> {
    // Determine cooldown duration based on error type
    let cooldownMs = 5 * 60 * 1000; // 5 minutes default
    
    if (error.includes('rate limit') || error.includes('429')) {
      cooldownMs = 15 * 60 * 1000; // 15 minutes for rate limits
    } else if (error.includes('503') || error.includes('502')) {
      cooldownMs = 2 * 60 * 1000; // 2 minutes for temporary outages
    }

    const cooldownUntil = Date.now() + cooldownMs;

    try {
      await this.selector.updateModelStatus(modelId, 'cooldown', cooldownUntil);
      
      // Also store in KV for faster access
      await this.env.MODEL_STATE.put(
        `cooldown:${modelId}`,
        JSON.stringify({ until: cooldownUntil, reason: error.slice(0, 100) }),
        { expirationTtl: Math.ceil(cooldownMs / 1000) }
      );
    } catch (e) {
      console.error('Failed to apply cooldown:', e);
    }
  }

  /**
   * Extract prompt text from messages
   */
  private extractPromptText(messages: Array<{ role: string; content: string | object }>): string {
    return messages
      .filter(m => m.role === 'user')
      .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content))
      .join(' ');
  }

  /**
   * Check if request requires vision capability
   */
  private requiresVision(request: IntelligentChatRequest): boolean {
    return request.messages.some(m => {
      const content = m.content;
      if (typeof content === 'object' && Array.isArray(content)) {
        return content.some((part: any) => part.type === 'image_url');
      }
      return false;
    });
  }

  /**
   * Log usage to D1
   */
  private async logUsage(entry: UsageLogEntry): Promise<void> {
    try {
      await this.env.AI_ROUTER_DB.prepare(`
        INSERT INTO usage_logs (
          request_id, use_case, complexity, prompt_hash, model_id, tier,
          benchmark_score, selection_reason, tokens_input, tokens_output,
          latency_ms, cost_usd, cached, success, error_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.request_id,
        entry.use_case,
        entry.complexity,
        entry.prompt_hash || null,
        entry.model_id,
        entry.tier,
        entry.benchmark_score,
        entry.selection_reason,
        entry.tokens_input || null,
        entry.tokens_output || null,
        entry.latency_ms,
        entry.cost_usd || null,
        entry.cached ? 1 : 0,
        entry.success ? 1 : 0,
        entry.error_code || null,
        Date.now()
      ).run();
    } catch (e) {
      console.error('Failed to log usage:', e);
    }
  }

  /**
   * Get router statistics
   */
  async getStats(): Promise<{
    models: Awaited<ReturnType<IntelligentModelSelector['getModelStats']>>;
    recentUsage: {
      total: number;
      byUseCase: Record<string, number>;
      avgLatency: number;
      successRate: number;
    };
  }> {
    const modelStats = await this.selector.getModelStats();
    
    // Get recent usage stats (last 24 hours)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const usageResult = await this.env.AI_ROUTER_DB.prepare(`
      SELECT 
        COUNT(*) as total,
        AVG(latency_ms) as avg_latency,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        use_case,
        COUNT(*) as count
      FROM usage_logs
      WHERE created_at > ?
      GROUP BY use_case
    `).bind(oneDayAgo).all<{
      total: number;
      avg_latency: number;
      successes: number;
      use_case: string;
      count: number;
    }>();

    const byUseCase: Record<string, number> = {};
    let total = 0;
    let avgLatency = 0;
    let successRate = 1;

    if (usageResult.results && usageResult.results.length > 0) {
      for (const row of usageResult.results) {
        byUseCase[row.use_case] = row.count;
        total += row.count;
      }
      const first = usageResult.results[0];
      avgLatency = first.avg_latency || 0;
      successRate = total > 0 ? (first.successes / total) : 1;
    }

    return {
      models: modelStats,
      recentUsage: {
        total,
        byUseCase,
        avgLatency,
        successRate,
      },
    };
  }
}
