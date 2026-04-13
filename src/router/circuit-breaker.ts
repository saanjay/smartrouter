/**
 * Circuit Breaker Pattern (v2.0)
 * 
 * Prevents cascade failures by:
 * - Opening circuit after N consecutive failures
 * - Half-open state for recovery testing
 * - Automatic recovery after cooldown
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Circuit tripped, requests fail fast
 * - HALF_OPEN: Testing recovery, limited requests allowed
 */

/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// Types
// =============================================================================

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitStatus {
  state: CircuitState;
  failures: number;
  lastFailure: number;
  lastSuccess: number;
  openedAt?: number;
  halfOpenAttempts: number;
}

export interface CircuitConfig {
  failureThreshold: number;      // Failures before opening (default: 5)
  resetTimeoutMs: number;        // Time before half-open (default: 60s)
  halfOpenMaxAttempts: number;   // Attempts in half-open (default: 3)
  successThreshold: number;      // Successes to close from half-open (default: 2)
}

const DEFAULT_CONFIG: CircuitConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,        // 1 minute
  halfOpenMaxAttempts: 3,
  successThreshold: 2,
};

// =============================================================================
// Circuit Breaker Class
// =============================================================================

export class CircuitBreaker {
  private kv: KVNamespace;
  private config: CircuitConfig;
  private localCache: Map<string, CircuitStatus> = new Map();
  private localCacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 5000;  // 5 second local cache
  
  constructor(kv: KVNamespace, config: Partial<CircuitConfig> = {}) {
    this.kv = kv;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Main Methods
  // ===========================================================================

  /**
   * Check if a model circuit is available for requests
   */
  async canRequest(modelId: string): Promise<{
    allowed: boolean;
    state: CircuitState;
    reason?: string;
  }> {
    const status = await this.getStatus(modelId);
    
    switch (status.state) {
      case 'closed':
        return { allowed: true, state: 'closed' };
        
      case 'open':
        // Check if we should transition to half-open
        const timeSinceOpen = Date.now() - (status.openedAt || 0);
        if (timeSinceOpen >= this.config.resetTimeoutMs) {
          // Transition to half-open
          await this.transitionTo(modelId, 'half_open');
          return { 
            allowed: true, 
            state: 'half_open',
            reason: 'Testing recovery after timeout',
          };
        }
        return { 
          allowed: false, 
          state: 'open',
          reason: `Circuit open, ${Math.ceil((this.config.resetTimeoutMs - timeSinceOpen) / 1000)}s until retry`,
        };
        
      case 'half_open':
        // Allow limited requests
        if (status.halfOpenAttempts < this.config.halfOpenMaxAttempts) {
          return { 
            allowed: true, 
            state: 'half_open',
            reason: `Recovery test ${status.halfOpenAttempts + 1}/${this.config.halfOpenMaxAttempts}`,
          };
        }
        return { 
          allowed: false, 
          state: 'half_open',
          reason: 'Max half-open attempts reached, waiting for results',
        };
    }
  }

  /**
   * Record a successful request
   */
  async recordSuccess(modelId: string): Promise<void> {
    const status = await this.getStatus(modelId);
    
    status.lastSuccess = Date.now();
    status.failures = 0;  // Reset consecutive failures
    
    if (status.state === 'half_open') {
      status.halfOpenAttempts++;
      
      // Check if we've had enough successes to close
      // In half-open, we track successful attempts
      if (status.halfOpenAttempts >= this.config.successThreshold) {
        console.log(`[CircuitBreaker] ${modelId}: Closing circuit after ${status.halfOpenAttempts} successful recovery attempts`);
        status.state = 'closed';
        status.halfOpenAttempts = 0;
        status.openedAt = undefined;
      }
    }
    
    await this.saveStatus(modelId, status);
  }

  /**
   * Record a failed request
   */
  async recordFailure(modelId: string, errorCode?: number): Promise<void> {
    const status = await this.getStatus(modelId);
    
    status.failures++;
    status.lastFailure = Date.now();
    
    if (status.state === 'half_open') {
      // Failure during recovery test - reopen circuit
      console.log(`[CircuitBreaker] ${modelId}: Failure during half-open, reopening circuit`);
      status.state = 'open';
      status.openedAt = Date.now();
      status.halfOpenAttempts = 0;
      
      // Extend timeout for repeated failures
      // This is handled by openedAt timestamp
    } else if (status.state === 'closed') {
      // Check if we should open the circuit
      if (status.failures >= this.config.failureThreshold) {
        console.log(`[CircuitBreaker] ${modelId}: Opening circuit after ${status.failures} consecutive failures`);
        status.state = 'open';
        status.openedAt = Date.now();
      }
    }
    
    await this.saveStatus(modelId, status);
  }

  /**
   * Force close a circuit (admin override)
   */
  async forceClose(modelId: string): Promise<void> {
    const status = this.createEmptyStatus();
    status.state = 'closed';
    await this.saveStatus(modelId, status);
    console.log(`[CircuitBreaker] ${modelId}: Force closed`);
  }

  /**
   * Force open a circuit (for maintenance)
   */
  async forceOpen(modelId: string): Promise<void> {
    const status = await this.getStatus(modelId);
    status.state = 'open';
    status.openedAt = Date.now();
    await this.saveStatus(modelId, status);
    console.log(`[CircuitBreaker] ${modelId}: Force opened`);
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get circuit status for a model
   */
  async getStatus(modelId: string): Promise<CircuitStatus> {
    // Check local cache first
    const cached = this.localCache.get(modelId);
    const cacheExpiry = this.localCacheExpiry.get(modelId) || 0;
    
    if (cached && Date.now() < cacheExpiry) {
      return cached;
    }
    
    // Load from KV
    const key = this.getKey(modelId);
    const data = await this.kv.get(key);
    
    let status: CircuitStatus;
    if (data) {
      try {
        status = JSON.parse(data) as CircuitStatus;
      } catch {
        status = this.createEmptyStatus();
      }
    } else {
      status = this.createEmptyStatus();
    }
    
    // Update local cache
    this.localCache.set(modelId, status);
    this.localCacheExpiry.set(modelId, Date.now() + this.CACHE_TTL_MS);
    
    return status;
  }

  /**
   * Get all open circuits (for monitoring)
   */
  async getOpenCircuits(): Promise<Array<{ modelId: string; status: CircuitStatus }>> {
    const list = await this.kv.list({ prefix: 'circuit:' });
    const openCircuits: Array<{ modelId: string; status: CircuitStatus }> = [];
    
    for (const key of list.keys) {
      const data = await this.kv.get(key.name);
      if (data) {
        try {
          const status = JSON.parse(data) as CircuitStatus;
          if (status.state !== 'closed') {
            const modelId = key.name.replace('circuit:', '').replace(/_/g, '/');
            openCircuits.push({ modelId, status });
          }
        } catch {
          // Skip invalid
        }
      }
    }
    
    return openCircuits;
  }

  /**
   * Get circuit statistics
   */
  async getStats(): Promise<{
    total: number;
    open: number;
    halfOpen: number;
    closed: number;
  }> {
    const list = await this.kv.list({ prefix: 'circuit:' });
    
    let open = 0;
    let halfOpen = 0;
    let closed = 0;
    
    for (const key of list.keys) {
      const data = await this.kv.get(key.name);
      if (data) {
        try {
          const status = JSON.parse(data) as CircuitStatus;
          switch (status.state) {
            case 'open': open++; break;
            case 'half_open': halfOpen++; break;
            case 'closed': closed++; break;
          }
        } catch {
          // Skip
        }
      }
    }
    
    return { total: open + halfOpen + closed, open, halfOpen, closed };
  }

  // ===========================================================================
  // Internal Methods
  // ===========================================================================

  private async transitionTo(modelId: string, state: CircuitState): Promise<void> {
    const status = await this.getStatus(modelId);
    
    console.log(`[CircuitBreaker] ${modelId}: ${status.state} → ${state}`);
    
    status.state = state;
    
    if (state === 'half_open') {
      status.halfOpenAttempts = 0;
    }
    
    await this.saveStatus(modelId, status);
  }

  private async saveStatus(modelId: string, status: CircuitStatus): Promise<void> {
    const key = this.getKey(modelId);
    
    await this.kv.put(key, JSON.stringify(status), {
      expirationTtl: 60 * 60 * 24,  // 24 hours
    });
    
    // Update local cache
    this.localCache.set(modelId, status);
    this.localCacheExpiry.set(modelId, Date.now() + this.CACHE_TTL_MS);
  }

  private getKey(modelId: string): string {
    const safeModelId = modelId.replace(/[:/]/g, '_');
    return `circuit:${safeModelId}`;
  }

  private createEmptyStatus(): CircuitStatus {
    return {
      state: 'closed',
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      halfOpenAttempts: 0,
    };
  }
}
