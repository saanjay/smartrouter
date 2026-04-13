/**
 * OpenRouter Smart Router - Entry Point
 *
 * Dynamic model discovery with Agentic Router.
 * 
 * Features:
 * - Dynamic model discovery (refreshed every 24h via cron)
 * - Agentic Router (free-first, epsilon-greedy exploration)
 * - KV-backed model registry + cooldowns
 * - Workers AI for embeddings
 */

import { SmartRouterService, type ChatRequest, type ChatResponse, type AIOperation } from './ai-service';
import { discoverModels, getDiscoveryStatus } from './router/model-discovery';
import { syncBenchmarks, getLastBenchmarkSync } from './router/benchmark-fetcher';

// =============================================================================
// Environment Interface for Scheduled Handler
// =============================================================================

interface ScheduledEnv {
  MODEL_STATE: KVNamespace;
  AI_ROUTER_DB: D1Database;
  AI_GATEWAY_ENDPOINT: string;
  AI_GATEWAY_TOKEN: string;
  OPENROUTER_API_KEY?: string;
}

// =============================================================================
// Scheduled Handler - Model Discovery (runs every 24h)
// =============================================================================

export async function scheduled(
  event: ScheduledEvent,
  env: ScheduledEnv,
  ctx: ExecutionContext
): Promise<void> {
  console.log(`[Discovery] Starting scheduled model discovery at ${new Date().toISOString()}`);
  
  try {
    const result = await discoverModels({
      MODEL_STATE: env.MODEL_STATE,
      AI_GATEWAY_ENDPOINT: env.AI_GATEWAY_ENDPOINT,
      AI_GATEWAY_TOKEN: env.AI_GATEWAY_TOKEN,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    });
    
    console.log(`[Discovery] Complete: ${result.validated}/${result.discovered} models validated`);
    console.log(`[Discovery] Free: ${result.models.filter(m => m.tier === 'free').length}`);
    console.log(`[Discovery] Cheap: ${result.models.filter(m => m.tier === 'cheap').length}`);
    console.log(`[Discovery] Premium: ${result.models.filter(m => m.tier === 'premium').length}`);
    
    if (result.errors.length > 0) {
      console.log(`[Discovery] Errors (first 5): ${result.errors.slice(0, 5).join(', ')}`);
    }

    // Also sync benchmarks to D1
    console.log(`[Benchmarks] Starting benchmark sync...`);
    const benchmarkResult = await syncBenchmarks({
      AI_ROUTER_DB: env.AI_ROUTER_DB,
      MODEL_STATE: env.MODEL_STATE,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    });
    console.log(`[Benchmarks] Complete: ${benchmarkResult.modelsUpdated} models updated, ${benchmarkResult.benchmarksUpdated} scores computed`);
    if (benchmarkResult.errors.length > 0) {
      console.log(`[Benchmarks] Errors (first 5): ${benchmarkResult.errors.slice(0, 5).join(', ')}`);
    }
  } catch (error) {
    console.error(`[Discovery] Failed:`, error);
  }
}

// =============================================================================
// NAMED ENTRYPOINT for RPC bindings from other services
// Other workers configure: entrypoint = "SmartRouterService"
// =============================================================================

export { SmartRouterService };

// Types re-exported for consumers
export type { ChatRequest, ChatResponse, AIOperation };

// Export discovery and benchmark functions for manual triggers
export { discoverModels, getDiscoveryStatus, syncBenchmarks, getLastBenchmarkSync };

// =============================================================================
// Default Export - SmartRouterService class for RPC bindings
// Other services: env.AI_SERVICE.chat({ ... })
// =============================================================================

export default SmartRouterService;
