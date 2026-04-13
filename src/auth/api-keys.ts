/**
 * API Key Authentication & Usage Tracking
 * 
 * Features:
 * - API key validation
 * - Per-key usage tracking (requests, tokens, cost)
 * - Rate limiting per key
 * - Key metadata (client name, created date, limits)
 */

// Using Web Crypto API (available in Cloudflare Workers)

// =============================================================================
// Types
// =============================================================================

export interface ApiKeyData {
  id: string;                    // Key ID (first 8 chars of hash)
  name: string;                  // Client name (e.g., "Nextgeek ATS")
  hashedKey: string;             // SHA-256 hash of the actual key
  createdAt: number;             // Unix timestamp
  expiresAt?: number;            // Optional expiration
  
  // Limits
  dailyRequestLimit?: number;    // Max requests per day
  monthlyTokenLimit?: number;    // Max tokens per month
  
  // Permissions
  allowedOperations?: string[];  // Empty = all operations allowed
  
  // Status
  active: boolean;
}

export interface UsageStats {
  keyId: string;
  
  // Daily stats (reset at midnight UTC)
  dailyRequests: number;
  dailyTokens: number;
  dailyCost: number;
  dailyResetAt: number;
  
  // Monthly stats (reset on 1st of month)
  monthlyRequests: number;
  monthlyTokens: number;
  monthlyCost: number;
  monthlyResetAt: number;
  
  // All-time stats
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  
  // Last request
  lastRequestAt: number;
}

export interface AuthResult {
  valid: boolean;
  keyId?: string;
  keyName?: string;
  error?: string;
  rateLimited?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

const API_KEY_PREFIX = 'apikey:';
const USAGE_PREFIX = 'usage:';
const KEY_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

// =============================================================================
// API Key Manager
// =============================================================================

export class ApiKeyManager {
  private kv: KVNamespace;

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  /**
   * Generate a new API key
   */
  async createKey(params: {
    name: string;
    dailyRequestLimit?: number;
    monthlyTokenLimit?: number;
    allowedOperations?: string[];
    expiresInDays?: number;
  }): Promise<{ key: string; keyId: string; data: ApiKeyData }> {
    // Generate a secure random key using Web Crypto API
    const randomArray = new Uint8Array(32);
    crypto.getRandomValues(randomArray);
    const rawKey = Array.from(randomArray).map(b => b.toString(16).padStart(2, '0')).join('');
    const keyPrefix = 'smr_'; // smart-router prefix
    const apiKey = `${keyPrefix}${rawKey}`;
    
    // Hash the key for storage using Web Crypto API
    const hashedKey = await this.hashKey(apiKey);
    const keyId = hashedKey.substring(0, 8);
    
    const now = Date.now();
    const keyData: ApiKeyData = {
      id: keyId,
      name: params.name,
      hashedKey,
      createdAt: now,
      expiresAt: params.expiresInDays 
        ? now + (params.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined,
      dailyRequestLimit: params.dailyRequestLimit,
      monthlyTokenLimit: params.monthlyTokenLimit,
      allowedOperations: params.allowedOperations,
      active: true,
    };

    // Store the key data
    await this.kv.put(
      `${API_KEY_PREFIX}${hashedKey}`,
      JSON.stringify(keyData),
      { expirationTtl: KEY_TTL_SECONDS }
    );

    // Initialize usage stats
    await this.initUsageStats(keyId);

    console.log(`[ApiKey] Created key for "${params.name}" (ID: ${keyId})`);
    
    return { key: apiKey, keyId, data: keyData };
  }

  /**
   * Validate an API key and check rate limits
   */
  async validateKey(apiKey: string, operation?: string): Promise<AuthResult> {
    if (!apiKey) {
      return { valid: false, error: 'API key required' };
    }

    // Validate format
    if (!apiKey.startsWith('smr_') || apiKey.length !== 69) {
      return { valid: false, error: 'Invalid API key format' };
    }

    // Hash and lookup
    const hashedKey = await this.hashKey(apiKey);
    const keyDataStr = await this.kv.get(`${API_KEY_PREFIX}${hashedKey}`);

    if (!keyDataStr) {
      return { valid: false, error: 'Invalid API key' };
    }

    const keyData: ApiKeyData = JSON.parse(keyDataStr);

    // Check if active
    if (!keyData.active) {
      return { valid: false, error: 'API key is disabled' };
    }

    // Check expiration
    if (keyData.expiresAt && Date.now() > keyData.expiresAt) {
      return { valid: false, error: 'API key has expired' };
    }

    // Check operation permission
    if (keyData.allowedOperations && keyData.allowedOperations.length > 0) {
      if (operation && !keyData.allowedOperations.includes(operation)) {
        return { 
          valid: false, 
          error: `Operation "${operation}" not allowed for this key`,
          keyId: keyData.id,
          keyName: keyData.name,
        };
      }
    }

    // Check rate limits
    const usage = await this.getUsageStats(keyData.id);
    
    if (keyData.dailyRequestLimit && usage.dailyRequests >= keyData.dailyRequestLimit) {
      return { 
        valid: false, 
        error: 'Daily request limit exceeded',
        keyId: keyData.id,
        keyName: keyData.name,
        rateLimited: true,
      };
    }

    if (keyData.monthlyTokenLimit && usage.monthlyTokens >= keyData.monthlyTokenLimit) {
      return { 
        valid: false, 
        error: 'Monthly token limit exceeded',
        keyId: keyData.id,
        keyName: keyData.name,
        rateLimited: true,
      };
    }

    return { 
      valid: true, 
      keyId: keyData.id,
      keyName: keyData.name,
    };
  }

  /**
   * Record usage for a key
   */
  async recordUsage(keyId: string, tokens: number, cost: number): Promise<void> {
    const usage = await this.getUsageStats(keyId);
    const now = Date.now();

    // Check if daily reset needed
    if (now > usage.dailyResetAt) {
      usage.dailyRequests = 0;
      usage.dailyTokens = 0;
      usage.dailyCost = 0;
      usage.dailyResetAt = this.getNextMidnightUTC();
    }

    // Check if monthly reset needed
    if (now > usage.monthlyResetAt) {
      usage.monthlyRequests = 0;
      usage.monthlyTokens = 0;
      usage.monthlyCost = 0;
      usage.monthlyResetAt = this.getNextMonthStartUTC();
    }

    // Update stats
    usage.dailyRequests++;
    usage.dailyTokens += tokens;
    usage.dailyCost += cost;

    usage.monthlyRequests++;
    usage.monthlyTokens += tokens;
    usage.monthlyCost += cost;

    usage.totalRequests++;
    usage.totalTokens += tokens;
    usage.totalCost += cost;

    usage.lastRequestAt = now;

    await this.kv.put(
      `${USAGE_PREFIX}${keyId}`,
      JSON.stringify(usage),
      { expirationTtl: KEY_TTL_SECONDS }
    );
  }

  /**
   * Get usage stats for a key
   */
  async getUsageStats(keyId: string): Promise<UsageStats> {
    const statsStr = await this.kv.get(`${USAGE_PREFIX}${keyId}`);
    
    if (statsStr) {
      return JSON.parse(statsStr);
    }

    return this.createEmptyUsageStats(keyId);
  }

  /**
   * List all API keys (for admin)
   */
  async listKeys(): Promise<Array<ApiKeyData & { usage: UsageStats }>> {
    const list = await this.kv.list({ prefix: API_KEY_PREFIX });
    const keys: Array<ApiKeyData & { usage: UsageStats }> = [];

    for (const key of list.keys) {
      const dataStr = await this.kv.get(key.name);
      if (dataStr) {
        const data: ApiKeyData = JSON.parse(dataStr);
        const usage = await this.getUsageStats(data.id);
        keys.push({ ...data, usage });
      }
    }

    return keys;
  }

  /**
   * Revoke an API key
   */
  async revokeKey(keyId: string): Promise<boolean> {
    const list = await this.kv.list({ prefix: API_KEY_PREFIX });
    
    for (const key of list.keys) {
      const dataStr = await this.kv.get(key.name);
      if (dataStr) {
        const data: ApiKeyData = JSON.parse(dataStr);
        if (data.id === keyId) {
          data.active = false;
          await this.kv.put(key.name, JSON.stringify(data));
          console.log(`[ApiKey] Revoked key ${keyId}`);
          return true;
        }
      }
    }

    return false;
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Hash an API key using Web Crypto API (SHA-256)
   */
  private async hashKey(apiKey: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(apiKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async initUsageStats(keyId: string): Promise<void> {
    const stats = this.createEmptyUsageStats(keyId);
    await this.kv.put(
      `${USAGE_PREFIX}${keyId}`,
      JSON.stringify(stats),
      { expirationTtl: KEY_TTL_SECONDS }
    );
  }

  private createEmptyUsageStats(keyId: string): UsageStats {
    return {
      keyId,
      dailyRequests: 0,
      dailyTokens: 0,
      dailyCost: 0,
      dailyResetAt: this.getNextMidnightUTC(),
      monthlyRequests: 0,
      monthlyTokens: 0,
      monthlyCost: 0,
      monthlyResetAt: this.getNextMonthStartUTC(),
      totalRequests: 0,
      totalTokens: 0,
      totalCost: 0,
      lastRequestAt: 0,
    };
  }

  private getNextMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.getTime();
  }

  private getNextMonthStartUTC(): number {
    const now = new Date();
    const nextMonth = new Date(now);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    return nextMonth.getTime();
  }
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request: Request): string | null {
  // Check Authorization header (Bearer token)
  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check X-API-Key header
  const apiKeyHeader = request.headers.get('X-API-Key');
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  return null;
}
