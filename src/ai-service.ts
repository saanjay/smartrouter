/**
 * OpenRouter Smart Router - Dynamic Model Discovery with Agentic Router
 *
 * This is the ONLY service that communicates with AI Gateway/OpenRouter.
 * All other services call this via RPC.
 *
 * Architecture:
 *   Consumer Service
 *     → RPC → Smart Router Service
 *       → Agentic Router (model selection from KV)
 *         → AI Gateway
 *           → OpenRouter
 *             → Provider
 *
 * Model Discovery:
 *   Cron (24h) → discoverModels() → Validate via AI Gateway → Store in KV
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import { 
  AgenticRouter, 
  type Operation, 
  type ChatRequest as RouterChatRequest,
  type RouteResult,
  OPERATION_CONFIG,
  discoverModels,
  getActiveModels,
  getDiscoveryStatus,
  type ServiceHealth,
} from './router';
import { 
  IntelligentRouter, 
  type IntelligentChatRequest,
  type IntelligentRouteResult,
} from './router/intelligent-router';
import { syncBenchmarks, getLastBenchmarkSync } from './router/benchmark-fetcher';
import { ApiKeyManager, extractApiKey, type UsageStats } from './auth/api-keys';

// =============================================================================
// Environment Interface
// =============================================================================

export interface AIServiceEnv {
  // KV for cooldown state
  MODEL_STATE: KVNamespace;
  
  // D1 Database for intelligent router
  AI_ROUTER_DB: D1Database;
  
  // Workers AI for embeddings
  AI: Ai;
  
  // AI Gateway configuration
  AI_GATEWAY_TOKEN: string;
  AI_GATEWAY_ENDPOINT: string;
  
  // Optional
  ENVIRONMENT?: string;
}

// =============================================================================
// Types (backward compatible with existing consumers)
// =============================================================================

export type AIOperation = Operation;

export interface ChatRequest {
  operation: AIOperation;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  options?: {
    temperature?: number;
    maxTokens?: number;
    skipCache?: boolean;
  };
  metadata?: {
    tenantId?: string;
    userId?: string;
    service?: string;
  };
}

export interface ChatResponse {
  success: boolean;
  content: string;
  model: string;
  tokens: { prompt: number; completion: number; total: number };
  cached: boolean;
  latencyMs: number;
  cost: number;
  error?: string;
}

// =============================================================================
// AI Service Class (RPC Entrypoint)
// =============================================================================

export class SmartRouterService extends WorkerEntrypoint<AIServiceEnv> {
  private router: AgenticRouter | null = null;
  private intelligentRouter: IntelligentRouter | null = null;
  private apiKeyManager: ApiKeyManager | null = null;

  private getApiKeyManager(): ApiKeyManager {
    if (!this.apiKeyManager) {
      this.apiKeyManager = new ApiKeyManager(this.env.MODEL_STATE);
    }
    return this.apiKeyManager;
  }

  private getRouter(): AgenticRouter {
    if (!this.router) {
      this.router = new AgenticRouter({
        MODEL_STATE: this.env.MODEL_STATE,
        AI_GATEWAY_ENDPOINT: this.env.AI_GATEWAY_ENDPOINT,
        AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
        AI: this.env.AI,  // For semantic cache embeddings
      });
    }
    return this.router;
  }

  private getIntelligentRouter(): IntelligentRouter {
    if (!this.intelligentRouter) {
      this.intelligentRouter = new IntelligentRouter({
        AI_ROUTER_DB: this.env.AI_ROUTER_DB,
        MODEL_STATE: this.env.MODEL_STATE,
        AI_GATEWAY_ENDPOINT: this.env.AI_GATEWAY_ENDPOINT,
        AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
      });
    }
    return this.intelligentRouter;
  }

  // =========================================================================
  // HTTP Handler (for admin/monitoring)
  // =========================================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Basic health check (quick)
    if (url.pathname === '/health') {
      const router = this.getRouter();
      const capacity = await router.hasMinimumCapacity();
      
      if (!capacity.viable) {
        return Response.json(
          { status: 'unhealthy', reason: capacity.reason },
          { status: 503 }
        );
      }
      
      return Response.json({ status: 'healthy' }, { status: 200 });
    }

    // Detailed health check (comprehensive)
    if (url.pathname === '/health/detailed') {
      const router = this.getRouter();
      const health = await router.getServiceHealth();
      
      const statusCode = health.status === 'critical' ? 503 
        : health.status === 'degraded' ? 200 
        : 200;
      
      return Response.json(health, { status: statusCode });
    }

    // Raw health metrics (for debugging)
    if (url.pathname === '/health/metrics') {
      const router = this.getRouter();
      const metrics = await router.getHealthMetrics();
      return Response.json(metrics);
    }

    // List available models (from KV)
    if (url.pathname === '/models') {
      const models = await getActiveModels(this.env.MODEL_STATE);
      return Response.json({
        models,
        count: models.length,
        byTier: {
          free: models.filter(m => m.tier === 'free').length,
          cheap: models.filter(m => m.tier === 'cheap').length,
          premium: models.filter(m => m.tier === 'premium').length,
        },
        operations: Object.keys(OPERATION_CONFIG),
      });
    }

    // Get discovery status
    if (url.pathname === '/discovery/status') {
      const status = await getDiscoveryStatus(this.env.MODEL_STATE);
      return Response.json(status);
    }

    // Trigger manual discovery (POST only)
    if (url.pathname === '/discovery/run' && request.method === 'POST') {
      try {
        const result = await discoverModels({
          MODEL_STATE: this.env.MODEL_STATE,
          AI_GATEWAY_ENDPOINT: this.env.AI_GATEWAY_ENDPOINT,
          AI_GATEWAY_TOKEN: this.env.AI_GATEWAY_TOKEN,
        });
        return Response.json({
          success: true,
          discovered: result.discovered,
          validated: result.validated,
          failed: result.failed,
          models: result.models.length,
          errors: result.errors.slice(0, 10),
        });
      } catch (error: any) {
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
    }

    // Get cooldown status
    if (url.pathname === '/cooldowns') {
      const router = this.getRouter();
      const status = await router.getCooldownStatus();
      return Response.json({ cooldowns: status });
    }

    // Clear all cooldowns (emergency recovery)
    if (url.pathname === '/cooldowns/clear' && request.method === 'POST') {
      const router = this.getRouter();
      await router.clearAllCooldowns();
      return Response.json({ success: true, message: 'All cooldowns cleared' });
    }

    // Chat endpoint (requires API key authentication)
    if (url.pathname === '/chat' && request.method === 'POST') {
      const apiKey = extractApiKey(request);
      const keyManager = this.getApiKeyManager();
      
      // Validate API key
      const body = await request.json() as ChatRequest;
      const authResult = await keyManager.validateKey(apiKey || '', body.operation);
      
      if (!authResult.valid) {
        return Response.json(
          { error: authResult.error, rateLimited: authResult.rateLimited },
          { status: authResult.rateLimited ? 429 : 401 }
        );
      }
      
      try {
        const result = await this.chat(body);
        
        // Record usage
        if (authResult.keyId) {
          await keyManager.recordUsage(
            authResult.keyId,
            result.tokens.total,
            result.cost
          );
        }
        
        return Response.json({
          ...result,
          _meta: { keyId: authResult.keyId, keyName: authResult.keyName },
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Intelligent chat endpoint (new benchmark-based routing)
    if (url.pathname === '/intelligent-chat' && request.method === 'POST') {
      try {
        const body = await request.json() as IntelligentChatRequest;
        const result = await this.intelligentChat(body);
        return Response.json(result);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Streaming chat endpoint — uses intelligent model selection, returns SSE stream
    // Called via service binding fetch (e.g., env.AI_SERVICE.fetch('/stream', ...))
    if (url.pathname === '/stream' && request.method === 'POST') {
      try {
        const body = await request.json() as IntelligentChatRequest;
        const router = this.getIntelligentRouter();

        // Use the intelligent router to select the best model (without calling it)
        const selectedModel = await router.selectModelForRequest(body);

        // Call AI Gateway with stream: true
        const streamResponse = await fetch(
          `${this.env.AI_GATEWAY_ENDPOINT}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'cf-aig-authorization': `Bearer ${this.env.AI_GATEWAY_TOKEN}`,
              'cf-aig-cache-ttl': '0', // No caching for streaming
              'cf-aig-metadata': JSON.stringify({
                service: body.metadata?.service || 'ai-discovery-stream',
                operation: 'stream',
                model: selectedModel.id,
              }),
            },
            body: JSON.stringify({
              model: selectedModel.id,
              messages: body.messages,
              temperature: body.temperature ?? 0.7,
              max_tokens: body.maxTokens ?? 1000,
              stream: true,
              user: body.metadata?.userId || body.metadata?.tenantId || 'system',
            }),
          }
        );

        if (!streamResponse.ok) {
          const errText = await streamResponse.text();
          return Response.json(
            { error: `AI Gateway error: ${streamResponse.status}`, detail: errText.slice(0, 200) },
            { status: streamResponse.status }
          );
        }

        // Pass through the SSE stream with the selected model ID in a header
        return new Response(streamResponse.body, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Model-Id': selectedModel.id,
          },
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Intelligent router stats
    if (url.pathname === '/intelligent/stats') {
      try {
        const router = this.getIntelligentRouter();
        const stats = await router.getStats();
        return Response.json(stats);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // =======================================================================
    // New Optimization Endpoints
    // =======================================================================

    // Comprehensive router stats (cache, budget, performance, health)
    if (url.pathname === '/stats') {
      try {
        const router = this.getRouter();
        const stats = await router.getRouterStats();
        return Response.json(stats);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Cache statistics
    if (url.pathname === '/cache/stats') {
      try {
        const router = this.getRouter();
        const stats = router.getCacheStats();
        return Response.json({ cache: stats || { enabled: false } });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Clear cache (POST only)
    if (url.pathname === '/cache/clear' && request.method === 'POST') {
      try {
        const router = this.getRouter();
        const result = await router.clearCache();
        return Response.json({ success: true, ...result });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Budget status
    if (url.pathname === '/budget/status') {
      try {
        const router = this.getRouter();
        const status = await router.getBudgetStatus();
        return Response.json(status);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Budget spending history
    if (url.pathname === '/budget/history') {
      try {
        const days = parseInt(url.searchParams.get('days') || '7');
        const router = this.getRouter();
        const history = await router.getSpendingHistory(days);
        return Response.json({ history });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Reset budget free-only mode (POST only)
    if (url.pathname === '/budget/reset' && request.method === 'POST') {
      try {
        const router = this.getRouter();
        await router.resetBudgetMode();
        return Response.json({ success: true, message: 'Free-only mode reset' });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Performance metrics for a model/operation
    if (url.pathname === '/performance/model') {
      try {
        const modelId = url.searchParams.get('model');
        const operation = url.searchParams.get('operation') as Operation;
        if (!modelId || !operation) {
          return Response.json({ error: 'model and operation query params required' }, { status: 400 });
        }
        const router = this.getRouter();
        const metrics = await router.getPerformanceMetrics(modelId, operation);
        return Response.json({ metrics });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Best performing models for an operation
    if (url.pathname === '/performance/best') {
      try {
        const operation = url.searchParams.get('operation') as Operation;
        const count = parseInt(url.searchParams.get('count') || '5');
        if (!operation) {
          return Response.json({ error: 'operation query param required' }, { status: 400 });
        }
        const router = this.getRouter();
        const models = await router.getBestModels(operation, count);
        return Response.json({ operation, models });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Benchmark sync status
    if (url.pathname === '/benchmarks/status') {
      try {
        const lastSync = await getLastBenchmarkSync({
          AI_ROUTER_DB: this.env.AI_ROUTER_DB,
          MODEL_STATE: this.env.MODEL_STATE,
        });
        return Response.json({
          lastSync,
          nextSync: lastSync ? new Date(lastSync.timestamp + 24 * 60 * 60 * 1000).toISOString() : 'pending',
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Manual benchmark sync trigger (POST only)
    if (url.pathname === '/benchmarks/sync' && request.method === 'POST') {
      try {
        const result = await syncBenchmarks({
          AI_ROUTER_DB: this.env.AI_ROUTER_DB,
          MODEL_STATE: this.env.MODEL_STATE,
        });
        // Invalidate intelligent router cache
        this.intelligentRouter = null;
        return Response.json({
          success: true,
          ...result,
        });
      } catch (error: any) {
        return Response.json({ success: false, error: error.message }, { status: 500 });
      }
    }

    // =======================================================================
    // API Key Management Endpoints (Admin)
    // =======================================================================

    // One-time key creation for Nextgeek ATS (remove after use)
    if (url.pathname === '/setup/nextgeek-ats' && request.method === 'POST') {
      try {
        const keyManager = this.getApiKeyManager();
        const result = await keyManager.createKey({
          name: 'Nextgeek ATS',
          dailyRequestLimit: 10000,
          monthlyTokenLimit: 50000000,  // 50M tokens/month
        });

        return Response.json({
          success: true,
          apiKey: result.key,  // Save this!
          keyId: result.keyId,
          name: result.data.name,
          limits: {
            dailyRequests: 10000,
            monthlyTokens: 50000000,
          },
          message: '⚠️ SAVE THIS KEY - it will not be shown again!',
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Create new API key
    if (url.pathname === '/admin/keys' && request.method === 'POST') {
      try {
        const adminKey = request.headers.get('X-Admin-Key');
        if (adminKey !== this.env.AI_GATEWAY_TOKEN) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json() as {
          name: string;
          dailyRequestLimit?: number;
          monthlyTokenLimit?: number;
          allowedOperations?: string[];
          expiresInDays?: number;
        };

        const keyManager = this.getApiKeyManager();
        const result = await keyManager.createKey(body);

        return Response.json({
          success: true,
          apiKey: result.key,  // Only shown once!
          keyId: result.keyId,
          name: result.data.name,
          message: 'Save this API key - it will not be shown again!',
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // List all API keys
    if (url.pathname === '/admin/keys' && request.method === 'GET') {
      try {
        const adminKey = request.headers.get('X-Admin-Key');
        if (adminKey !== this.env.AI_GATEWAY_TOKEN) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const keyManager = this.getApiKeyManager();
        const keys = await keyManager.listKeys();

        // Don't expose the actual keys, just metadata and usage
        return Response.json({
          keys: keys.map(k => ({
            id: k.id,
            name: k.name,
            active: k.active,
            createdAt: new Date(k.createdAt).toISOString(),
            expiresAt: k.expiresAt ? new Date(k.expiresAt).toISOString() : null,
            dailyRequestLimit: k.dailyRequestLimit,
            monthlyTokenLimit: k.monthlyTokenLimit,
            usage: k.usage,
          })),
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Get usage stats for a specific key
    if (url.pathname.startsWith('/admin/keys/') && url.pathname.endsWith('/usage')) {
      try {
        const adminKey = request.headers.get('X-Admin-Key');
        if (adminKey !== this.env.AI_GATEWAY_TOKEN) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const keyId = url.pathname.split('/')[3];
        const keyManager = this.getApiKeyManager();
        const usage = await keyManager.getUsageStats(keyId);

        return Response.json({ keyId, usage });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Revoke an API key
    if (url.pathname.startsWith('/admin/keys/') && request.method === 'DELETE') {
      try {
        const adminKey = request.headers.get('X-Admin-Key');
        if (adminKey !== this.env.AI_GATEWAY_TOKEN) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const keyId = url.pathname.split('/')[3];
        const keyManager = this.getApiKeyManager();
        const revoked = await keyManager.revokeKey(keyId);

        return Response.json({
          success: revoked,
          message: revoked ? 'Key revoked' : 'Key not found',
        });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // =======================================================================
    // v2.0 Endpoints: Quality Tracking & Circuit Breaker
    // =======================================================================

    // Quality tracker aggregate metrics
    if (url.pathname === '/quality/metrics') {
      try {
        const router = this.getRouter();
        const metrics = await router.getQualityMetrics();
        return Response.json(metrics);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Quality stats for a specific operation
    if (url.pathname === '/quality/operation') {
      try {
        const operation = url.searchParams.get('operation');
        if (!operation) {
          return Response.json({ error: 'operation query param required' }, { status: 400 });
        }
        const router = this.getRouter();
        const stats = await router.getQualityStatsForOperation(operation);
        return Response.json({ operation, stats });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Top performing models for an operation
    if (url.pathname === '/quality/top') {
      try {
        const operation = url.searchParams.get('operation');
        const limit = parseInt(url.searchParams.get('limit') || '10');
        if (!operation) {
          return Response.json({ error: 'operation query param required' }, { status: 400 });
        }
        const router = this.getRouter();
        const models = await router.getTopQualityModels(operation, limit);
        return Response.json({ operation, models });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Circuit breaker status
    if (url.pathname === '/circuits') {
      try {
        const router = this.getRouter();
        const circuits = await router.getCircuitBreakerStats();
        return Response.json(circuits);
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Open circuits only
    if (url.pathname === '/circuits/open') {
      try {
        const router = this.getRouter();
        const openCircuits = await router.getOpenCircuits();
        return Response.json({ openCircuits });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    // Force close a circuit (admin)
    if (url.pathname.startsWith('/circuits/close/') && request.method === 'POST') {
      try {
        const modelId = decodeURIComponent(url.pathname.split('/circuits/close/')[1]);
        const router = this.getRouter();
        await router.forceCloseCircuit(modelId);
        return Response.json({ success: true, modelId, message: 'Circuit closed' });
      } catch (error: any) {
        return Response.json({ error: error.message }, { status: 500 });
      }
    }

    return Response.json({
      service: 'openrouter-smart-router',
      version: '2.0',
      architecture: 'dynamic-agentic-router-v2-thompson-sampling',
      features: [
        'health-tracking',
        'progressive-cooldowns',
        'service-health-monitoring',
        'api-key-authentication',
        'usage-tracking',
        'semantic-caching',
        'budget-guards',
        'performance-tracking',
        'bulk-operations',
        // v2.0 features
        'thompson-sampling',
        'circuit-breaker',
        'quality-feedback-loop',
        'actual-cost-tracking',
        'expanded-free-models',
      ],
      rpcMethods: ['chat', 'embed', 'intelligentChat', 'getServiceHealth'],
      httpEndpoints: [
        '/health',
        '/health/detailed',
        '/health/metrics',
        '/models',
        '/discovery/status',
        '/discovery/run',
        '/cooldowns',
        '/cooldowns/clear',
        '/chat (requires API key)',
        '/intelligent-chat',
        '/intelligent/stats',
        '/stats',
        '/cache/stats',
        '/cache/clear',
        '/budget/status',
        '/budget/history',
        '/budget/reset',
        '/performance/model',
        '/performance/best',
        '/benchmarks/status',
        '/benchmarks/sync',
        '/admin/keys (admin only)',
        // v2.0 endpoints
        '/quality/metrics',
        '/quality/operation?operation=X',
        '/quality/top?operation=X&limit=N',
        '/circuits',
        '/circuits/open',
        '/circuits/close/:modelId',
      ],
    });
  }

  // =========================================================================
  // RPC Methods (called by other services via service bindings)
  // =========================================================================

  /**
   * Chat completion with Agentic Router model selection.
   * This is the main method other services call.
   */
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const router = this.getRouter();

    // Convert to router request format
    const routerRequest: RouterChatRequest = {
      messages: request.messages,
      temperature: request.options?.temperature,
      maxTokens: request.options?.maxTokens,
      skipCache: request.options?.skipCache,
      metadata: request.metadata,
    };

    // Route the request
    const result: RouteResult = await router.route(request.operation, routerRequest);

    // Convert to response format (backward compatible)
    return {
      success: result.success,
      content: result.content,
      model: result.model,
      tokens: result.tokens,
      cached: result.cached,
      latencyMs: result.latencyMs,
      cost: result.estimatedCost || 0,
      error: result.error,
    };
  }

  /**
   * Intelligent chat completion with benchmark-based model selection.
   * Uses use-case classification and quality thresholds.
   */
  async intelligentChat(request: IntelligentChatRequest): Promise<IntelligentRouteResult> {
    const router = this.getIntelligentRouter();
    return router.route(request);
  }

  /**
   * Get service health status (RPC callable)
   * Other services can check if AI service is healthy before making requests
   */
  async getServiceHealth(): Promise<ServiceHealth> {
    const router = this.getRouter();
    return router.getServiceHealth();
  }

  /**
   * Generate embeddings using Workers AI (free!)
   */
  async embed(inputs: string[], model?: string): Promise<{
    success: boolean;
    embeddings: number[][];
    model: string;
    error?: string;
  }> {
    try {
      const embeddingModel = model || '@cf/baai/bge-large-en-v1.5';

      const result = await this.env.AI.run(embeddingModel as any, {
        text: inputs,
      }) as unknown as { data: number[][] };

      return {
        success: true,
        embeddings: result.data,
        model: embeddingModel,
      };
    } catch (error: any) {
      return {
        success: false,
        embeddings: [],
        model: model || '@cf/baai/bge-large-en-v1.5',
        error: error.message,
      };
    }
  }
}
