/**
 * AI Service Binding Types
 * 
 * Shared type definitions for AI_SERVICE RPC binding
 * Used by all services that consume AI via service bindings
 */

// =============================================================================
// Request Types
// =============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | object;
}

/**
 * Legacy chat request (Agentic Router)
 * Uses operation-based model selection
 */
export interface ChatRequest {
  operation: string;
  messages: ChatMessage[];
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

/**
 * Intelligent chat request (Intelligent Router)
 * Uses benchmark-based model selection with use-case classification
 */
export interface IntelligentChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  skipCache?: boolean;
  responseFormat?: { type: 'json_object' | 'text' };
  metadata?: {
    tenantId?: string;
    userId?: string;
    service?: string;
  };
}

// =============================================================================
// Response Types
// =============================================================================

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

/**
 * Legacy chat response (Agentic Router)
 */
export interface ChatResponse {
  success: boolean;
  content: string;
  model: string;
  tokens: TokenUsage;
  cached: boolean;
  latencyMs: number;
  cost: number;
  error?: string;
}

/**
 * Intelligent chat response (Intelligent Router)
 * Includes classification and selection details
 */
export interface IntelligentChatResponse {
  success: boolean;
  content: string;
  model: string;
  tier: string;
  tokens: TokenUsage;
  cached: boolean;
  latencyMs: number;
  estimatedCost: number;
  classification: {
    useCase: string;
    confidence: number;
    complexity: string;
    keywords: string[];
    secondaryUseCases: string[];
  };
  selection: {
    model: {
      id: string;
      provider: string;
      name: string;
      is_free: boolean | number;
    };
    score: number;
    tier: string;
    reason: string;
    fallback: boolean;
  };
  error?: string;
}

// =============================================================================
// Service Binding Interface
// =============================================================================

/**
 * AI Service RPC binding interface
 * 
 * Usage in wrangler.toml:
 * [[services]]
 * binding = "AI_SERVICE"
 * service = "openrouter-smart-router"
 * entrypoint = "SmartRouterService"
 */
export interface AIServiceBinding {
  /**
   * Legacy chat method (Agentic Router)
   * @deprecated Use intelligentChat for benchmark-based routing
   */
  chat(request: ChatRequest): Promise<ChatResponse>;

  /**
   * Intelligent chat method (Intelligent Router)
   * Uses use-case classification and benchmark-based model selection
   */
  intelligentChat(request: IntelligentChatRequest): Promise<IntelligentChatResponse>;

  /**
   * Generate embeddings using Workers AI
   */
  embed(inputs: string[], model?: string): Promise<{
    success: boolean;
    embeddings: number[][];
    model: string;
    error?: string;
  }>;
}
