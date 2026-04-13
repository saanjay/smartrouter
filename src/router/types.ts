/**
 * Agentic AI Router - Type Definitions
 * 
 * Clean type system for the simplified routing architecture.
 */

// =============================================================================
// Modalities - What kind of AI task is this?
// =============================================================================

export type Modality = 
  | 'text_chat'      // Standard LLM chat (text in, text out)
  | 'vision_chat'    // Image + text in, text out
  | 'embeddings';    // Text in, vector out (Workers AI)

// Future modalities (V2):
// | 'image_generate'   // Text in, image out
// | 'image_enhance'    // Image in, enhanced image out
// | 'audio_transcribe' // Audio in, text out
// | 'video_job'        // Async video processing

// =============================================================================
// Capabilities - What is the model good at?
// =============================================================================

export type Capability = 
  | 'structured'  // Good at JSON output, extraction
  | 'reasoning'   // Deep thinking, analysis, logic
  | 'creative'    // Generation, ideation, writing
  | 'coding'      // Code understanding and generation
  | 'vision'      // Can process images
  | 'balanced';   // General purpose, jack of all trades

// =============================================================================
// Tiers - Cost/quality tradeoff
// =============================================================================

export type Tier = 'free' | 'cheap' | 'premium';

// =============================================================================
// Operations - business operations
// =============================================================================

export type Operation = 
  | 'resume-parse'          // Extract structured data from resumes
  | 'resume-parse-bulk'     // Bulk resume parsing (cost-optimized, free-only)
  | 'resume-cessr'          // Deep career analysis (CESSR framework)
  | 'interview-questions'   // Generate interview questions
  | 'interview-score'       // Score candidate responses
  | 'assessment'            // Technical skill assessment
  | 'match-report'          // Candidate-job matching analysis
  | 'job-parse'             // Extract job requirements
  | 'job-parse-bulk'        // Bulk job parsing (cost-optimized)
  | 'job-enrich'            // Enhance job data with context
  | 'generic'               // Catch-all for other tasks
  // Talent Verification Operations
  | 'context-extraction'    // Extract skills/roles/experience from resume
  | 'qualifying-questions'  // Generate role/skill clarification questions
  | 'arena-questions'       // Generate skill assessment MCQs
  | 'competency-scoring'    // Score open-ended competency responses
  // Question Bank Operations
  | 'question-generate'     // Generate MCQ questions for skill assessment
  | 'question-curate'       // Validate and grade questions with IRT params
  | 'test';                 // General testing and debugging

// =============================================================================
// Task Specification - What the caller needs
// =============================================================================

export interface TaskSpec {
  operation: Operation;
  modality?: Modality;  // Defaults to 'text_chat'
  constraints?: {
    maxLatencyMs?: number;
    minContextLength?: number;
    needsStructuredOutput?: boolean;
  };
}

// =============================================================================
// Model Profile - Static model information
// =============================================================================

export interface ModelProfile {
  id: string;
  tier: Tier;
  capabilities: Capability[];
  modalities: Modality[];
  contextLength: number;
  supportsStructuredOutput: boolean;
  provider: string;
}

// =============================================================================
// Chat Request/Response - What flows through the router
// =============================================================================

export interface ChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  skipCache?: boolean;
  forceFreeOnly?: boolean;       // Force free tier for this request
  // OpenRouter structured output support (v2.0)
  responseFormat?: { type: 'json_object' } | {
    type: 'json_schema';
    json_schema: {
      name: string;
      strict?: boolean;
      schema: object;
    };
  };
  metadata?: {
    tenantId?: string;
    userId?: string;
    service?: string;
    requestId?: string;          // For tracking/debugging
    batchId?: string;            // For batch operations
  };
}

export interface RouteResult {
  success: boolean;
  model: string;
  tier: Tier;
  content: string;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  latencyMs: number;
  cached: boolean;
  cacheLevel?: 'exact' | 'semantic';  // Which cache level hit
  error?: string;
  // For cost tracking
  estimatedCost?: number;
  // Performance tracking
  retryCount?: number;
  modelsAttempted?: string[];
}

// =============================================================================
// Router Configuration
// =============================================================================

export interface RouterConfig {
  // Exploration rates (epsilon-greedy)
  cheapExplorationRate: number;   // e.g., 0.05 = 5%
  premiumExplorationRate: number; // e.g., 0.01 = 1%
  
  // Cooldown durations
  defaultCooldownMs: number;      // Standard failure
  rateLimitCooldownMs: number;    // 429 response
  notFoundCooldownMs: number;     // 404 response
  
  // Safety limits
  maxRetriesPerTier: number;
  dailyCostCapUsd?: number;
}

export const DEFAULT_CONFIG: RouterConfig = {
  cheapExplorationRate: 0.05,
  premiumExplorationRate: 0.01,
  defaultCooldownMs: 5 * 60 * 1000,       // 5 minutes
  rateLimitCooldownMs: 10 * 60 * 1000,    // 10 minutes
  notFoundCooldownMs: 60 * 60 * 1000,     // 1 hour
  maxRetriesPerTier: 3,
  dailyCostCapUsd: 50,
};

// =============================================================================
// Operation Configuration - Maps operations to required capabilities
// =============================================================================

export interface OperationConfig {
  requiredCapabilities: Capability[];
  preferredModality: Modality;
  description: string;
  preferFast?: boolean;
  minContextLength?: number;
  // Bulk operation settings
  explorationRate?: number;      // Override default exploration (0 = no exploration)
  forceFreeOnly?: boolean;       // Force free tier only
  maxRetries?: number;           // Override default retries
  timeoutMs?: number;            // Override default timeout
  enableCache?: boolean;         // Enable semantic caching (default: true)
  qualityThreshold?: number;     // Override quality threshold for model selection
}

// =============================================================================
// Cooldown State - Stored in KV
// =============================================================================

export interface CooldownState {
  until: number;      // Unix timestamp (ms)
  reason: string;     // Why cooldown was applied
  errorCode?: number; // HTTP status that triggered it
}
