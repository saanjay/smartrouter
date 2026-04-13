/**
 * Agentic AI Router - Cooldown Manager
 * 
 * KV-backed cooldown state management for global coordination.
 * Ensures cooldowns persist across Worker isolates.
 */

import type { CooldownState, RouterConfig, DEFAULT_CONFIG } from './types';

// =============================================================================
// Cooldown Manager
// =============================================================================

export class CooldownManager {
  private kv: KVNamespace;
  private config: RouterConfig;
  private prefix = 'cooldown:';
  
  // In-memory cache to reduce KV reads (TTL: 30s)
  private cache: Map<string, { state: CooldownState | null; cachedAt: number }> = new Map();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(kv: KVNamespace, config: RouterConfig) {
    this.kv = kv;
    this.config = config;
  }

  /**
   * Check if a model is available (not in cooldown)
   */
  async isAvailable(modelId: string): Promise<boolean> {
    const state = await this.getCooldownState(modelId);
    
    if (!state) return true;
    
    const now = Date.now();
    if (now > state.until) {
      // Cooldown expired, clear it
      await this.clearCooldown(modelId);
      return true;
    }
    
    return false;
  }

  /**
   * Set a model on cooldown
   * @param multiplier - Progressive multiplier for consecutive failures (default 1)
   */
  async setCooldown(
    modelId: string, 
    reason: string, 
    errorCode?: number,
    multiplier: number = 1
  ): Promise<void> {
    const baseDuration = this.getCooldownDuration(errorCode);
    const duration = baseDuration * multiplier;
    const until = Date.now() + duration;
    
    const state: CooldownState = {
      until,
      reason,
      errorCode,
    };
    
    const key = this.prefix + modelId;
    const ttlSeconds = Math.ceil(duration / 1000);
    
    await this.kv.put(key, JSON.stringify(state), {
      expirationTtl: ttlSeconds,
    });
    
    // Update cache
    this.cache.set(modelId, { state, cachedAt: Date.now() });
    
    console.log(`[Cooldown] ${modelId} → ${reason} (${Math.round(duration / 60000)}min)`);
  }

  /**
   * Clear a model's cooldown
   */
  async clearCooldown(modelId: string): Promise<void> {
    const key = this.prefix + modelId;
    await this.kv.delete(key);
    this.cache.delete(modelId);
  }

  /**
   * Get cooldown state for a model
   */
  private async getCooldownState(modelId: string): Promise<CooldownState | null> {
    // Check cache first
    const cached = this.cache.get(modelId);
    if (cached && (Date.now() - cached.cachedAt) < this.CACHE_TTL_MS) {
      return cached.state;
    }
    
    // Fetch from KV
    const key = this.prefix + modelId;
    const value = await this.kv.get(key);
    
    if (!value) {
      this.cache.set(modelId, { state: null, cachedAt: Date.now() });
      return null;
    }
    
    try {
      const state = JSON.parse(value) as CooldownState;
      this.cache.set(modelId, { state, cachedAt: Date.now() });
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Get cooldown duration based on error type
   */
  private getCooldownDuration(errorCode?: number): number {
    if (errorCode === 429) {
      return this.config.rateLimitCooldownMs;
    }
    if (errorCode === 404) {
      return this.config.notFoundCooldownMs;
    }
    return this.config.defaultCooldownMs;
  }

  /**
   * Filter a list of models to only available ones
   */
  async filterAvailable(modelIds: string[]): Promise<string[]> {
    const results = await Promise.all(
      modelIds.map(async (id) => ({
        id,
        available: await this.isAvailable(id),
      }))
    );
    
    return results.filter(r => r.available).map(r => r.id);
  }

  /**
   * Get all models currently on cooldown (for debugging)
   */
  async getCooldownStatus(): Promise<Record<string, CooldownState>> {
    const status: Record<string, CooldownState> = {};
    
    // List all cooldown keys
    const list = await this.kv.list({ prefix: this.prefix });
    
    for (const key of list.keys) {
      const modelId = key.name.replace(this.prefix, '');
      const state = await this.getCooldownState(modelId);
      if (state) {
        status[modelId] = state;
      }
    }
    
    return status;
  }
}
