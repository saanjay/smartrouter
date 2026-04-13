/**
 * Semantic Cache for AI Discovery
 * 
 * Two-level caching system:
 * 1. Level 1: Exact hash match (SHA-256) - Fast, 100% accurate
 * 2. Level 2: Semantic similarity (embeddings) - Fuzzy match for similar content
 * 
 * Expected savings: 25-40% on repeated/similar requests
 */

/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// Types
// =============================================================================

export interface CachedResponse {
  content: string;
  model: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  cachedAt: number;
  hitCount: number;
  originalPromptLength: number;
}

export interface CacheStats {
  exactHits: number;
  semanticHits: number;
  misses: number;
  totalRequests: number;
  hitRate: number;
  savedTokens: number;
  savedCostUsd: number;
}

export interface SemanticCacheConfig {
  enabled: boolean;
  exactCacheTtlSeconds: number;      // 24 hours default
  semanticCacheTtlSeconds: number;   // 12 hours default
  similarityThreshold: number;        // 0.95 default
  maxCacheEntries: number;            // 10000 default
  enableSemanticLevel: boolean;       // Can disable for speed
}

const DEFAULT_CONFIG: SemanticCacheConfig = {
  enabled: true,
  exactCacheTtlSeconds: 86400,        // 24 hours
  semanticCacheTtlSeconds: 43200,     // 12 hours
  similarityThreshold: 0.95,
  maxCacheEntries: 10000,
  enableSemanticLevel: true,
};

// =============================================================================
// Semantic Cache Class
// =============================================================================

export class SemanticCache {
  private kv: KVNamespace;
  private ai: Ai;
  private vectorIndex: VectorizeIndex | null;
  private config: SemanticCacheConfig;
  
  // In-memory stats (reset on worker restart)
  private stats: CacheStats = {
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    totalRequests: 0,
    hitRate: 0,
    savedTokens: 0,
    savedCostUsd: 0,
  };

  constructor(
    kv: KVNamespace,
    ai: Ai,
    vectorIndex: VectorizeIndex | null = null,
    config: Partial<SemanticCacheConfig> = {}
  ) {
    this.kv = kv;
    this.ai = ai;
    this.vectorIndex = vectorIndex;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Main Cache Methods
  // ===========================================================================

  /**
   * Check cache for a prompt (both levels)
   */
  async get(
    prompt: string,
    operation: string
  ): Promise<{ hit: boolean; level?: 'exact' | 'semantic'; response?: CachedResponse }> {
    if (!this.config.enabled) {
      return { hit: false };
    }

    this.stats.totalRequests++;

    // Level 1: Exact hash match
    const exactResult = await this.checkExactCache(prompt, operation);
    if (exactResult) {
      this.stats.exactHits++;
      this.stats.savedTokens += exactResult.tokens.total;
      this.stats.savedCostUsd += this.estimateCost(exactResult.tokens);
      this.updateHitRate();
      
      // Increment hit count
      await this.incrementHitCount(prompt, operation, 'exact');
      
      return { hit: true, level: 'exact', response: exactResult };
    }

    // Level 2: Semantic similarity (if enabled and vector index available)
    if (this.config.enableSemanticLevel && this.vectorIndex) {
      const semanticResult = await this.checkSemanticCache(prompt, operation);
      if (semanticResult) {
        this.stats.semanticHits++;
        this.stats.savedTokens += semanticResult.tokens.total;
        this.stats.savedCostUsd += this.estimateCost(semanticResult.tokens);
        this.updateHitRate();
        
        return { hit: true, level: 'semantic', response: semanticResult };
      }
    }

    this.stats.misses++;
    this.updateHitRate();
    return { hit: false };
  }

  /**
   * Store a response in cache (both levels)
   */
  async set(
    prompt: string,
    operation: string,
    response: Omit<CachedResponse, 'cachedAt' | 'hitCount' | 'originalPromptLength'>
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const fullResponse: CachedResponse = {
      ...response,
      cachedAt: Date.now(),
      hitCount: 0,
      originalPromptLength: prompt.length,
    };

    // Level 1: Store exact hash
    await this.storeExactCache(prompt, operation, fullResponse);

    // Level 2: Store semantic embedding (if enabled)
    if (this.config.enableSemanticLevel && this.vectorIndex) {
      await this.storeSemanticCache(prompt, operation, fullResponse);
    }
  }

  // ===========================================================================
  // Level 1: Exact Hash Cache
  // ===========================================================================

  private async checkExactCache(
    prompt: string,
    operation: string
  ): Promise<CachedResponse | null> {
    const hash = await this.hashPrompt(prompt, operation);
    const key = `cache:exact:${hash}`;
    
    const cached = await this.kv.get(key);
    if (!cached) return null;
    
    try {
      return JSON.parse(cached) as CachedResponse;
    } catch {
      return null;
    }
  }

  private async storeExactCache(
    prompt: string,
    operation: string,
    response: CachedResponse
  ): Promise<void> {
    const hash = await this.hashPrompt(prompt, operation);
    const key = `cache:exact:${hash}`;
    
    await this.kv.put(key, JSON.stringify(response), {
      expirationTtl: this.config.exactCacheTtlSeconds,
    });
  }

  private async hashPrompt(prompt: string, operation: string): Promise<string> {
    const combined = `${operation}:${prompt}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(combined);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ===========================================================================
  // Level 2: Semantic Similarity Cache
  // ===========================================================================

  private async checkSemanticCache(
    prompt: string,
    operation: string
  ): Promise<CachedResponse | null> {
    if (!this.vectorIndex) return null;

    try {
      // Generate embedding for the prompt
      const embedding = await this.generateEmbedding(prompt);
      if (!embedding) return null;

      // Query vector index for similar prompts
      const results = await this.vectorIndex.query(embedding, {
        topK: 1,
        filter: { operation },
        returnMetadata: 'all',
      });

      if (results.matches.length === 0) return null;

      const match = results.matches[0];
      
      // Check similarity threshold
      if (match.score < this.config.similarityThreshold) {
        console.log(`[SemanticCache] Below threshold: ${match.score.toFixed(3)} < ${this.config.similarityThreshold}`);
        return null;
      }

      console.log(`[SemanticCache] Similarity match: ${match.score.toFixed(3)}`);

      // Fetch cached response from KV
      const cacheKey = `cache:semantic:${match.id}`;
      const cached = await this.kv.get(cacheKey);
      
      if (!cached) return null;
      
      return JSON.parse(cached) as CachedResponse;
    } catch (error) {
      console.error('[SemanticCache] Error checking semantic cache:', error);
      return null;
    }
  }

  private async storeSemanticCache(
    prompt: string,
    operation: string,
    response: CachedResponse
  ): Promise<void> {
    if (!this.vectorIndex) return;

    try {
      // Generate embedding
      const embedding = await this.generateEmbedding(prompt);
      if (!embedding) return;

      // Generate unique ID for this cache entry
      const id = crypto.randomUUID();
      
      // Store in vector index
      await this.vectorIndex.upsert([{
        id,
        values: embedding,
        metadata: {
          operation,
          cachedAt: Date.now(),
          promptLength: prompt.length,
        },
      }]);

      // Store response in KV (linked by ID)
      const cacheKey = `cache:semantic:${id}`;
      await this.kv.put(cacheKey, JSON.stringify(response), {
        expirationTtl: this.config.semanticCacheTtlSeconds,
      });
    } catch (error) {
      console.error('[SemanticCache] Error storing semantic cache:', error);
    }
  }

  private async generateEmbedding(text: string): Promise<number[] | null> {
    try {
      // Truncate if too long (embedding model limit)
      const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
      
      const result = await this.ai.run('@cf/baai/bge-large-en-v1.5', {
        text: [truncated],
      }) as { data: number[][] };

      return result.data[0] || null;
    } catch (error) {
      console.error('[SemanticCache] Error generating embedding:', error);
      return null;
    }
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  private async incrementHitCount(
    prompt: string,
    operation: string,
    level: 'exact' | 'semantic'
  ): Promise<void> {
    try {
      const hash = await this.hashPrompt(prompt, operation);
      const key = `cache:exact:${hash}`;
      
      const cached = await this.kv.get(key);
      if (cached) {
        const response = JSON.parse(cached) as CachedResponse;
        response.hitCount++;
        await this.kv.put(key, JSON.stringify(response), {
          expirationTtl: this.config.exactCacheTtlSeconds,
        });
      }
    } catch {
      // Ignore errors in hit count update
    }
  }

  private estimateCost(tokens: { prompt: number; completion: number }): number {
    // Rough estimate using GPT-4o-mini pricing
    const inputCost = (tokens.prompt / 1_000_000) * 0.15;
    const outputCost = (tokens.completion / 1_000_000) * 0.60;
    return inputCost + outputCost;
  }

  private updateHitRate(): void {
    const totalHits = this.stats.exactHits + this.stats.semanticHits;
    this.stats.hitRate = this.stats.totalRequests > 0 
      ? totalHits / this.stats.totalRequests 
      : 0;
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Clear all cache entries (use with caution)
   */
  async clearAll(): Promise<{ deleted: number }> {
    let deleted = 0;
    
    // List and delete exact cache entries
    const exactList = await this.kv.list({ prefix: 'cache:exact:' });
    for (const key of exactList.keys) {
      await this.kv.delete(key.name);
      deleted++;
    }
    
    // List and delete semantic cache entries
    const semanticList = await this.kv.list({ prefix: 'cache:semantic:' });
    for (const key of semanticList.keys) {
      await this.kv.delete(key.name);
      deleted++;
    }
    
    // Note: Vector index entries will expire naturally
    // (No bulk delete API for Vectorize)
    
    return { deleted };
  }

  /**
   * Get cache entry count
   */
  async getEntryCount(): Promise<{ exact: number; semantic: number }> {
    const exactList = await this.kv.list({ prefix: 'cache:exact:', limit: 1000 });
    const semanticList = await this.kv.list({ prefix: 'cache:semantic:', limit: 1000 });
    
    return {
      exact: exactList.keys.length,
      semantic: semanticList.keys.length,
    };
  }
}
