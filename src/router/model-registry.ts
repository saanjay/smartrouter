/**
 * Agentic AI Router - Dynamic Model Registry
 * 
 * Dynamically loaded from KV, populated by model discovery.
 * No hardcoded models except ultimate fallback.
 */

/// <reference types="@cloudflare/workers-types" />

import type { 
  ModelProfile, 
  Capability, 
  Tier, 
  Operation, 
  OperationConfig,
  Modality 
} from './types';
import { getActiveModels, getFallbackModels } from './model-discovery';

// =============================================================================
// Dynamic Model Registry
// =============================================================================

export class DynamicModelRegistry {
  private models: ModelProfile[] = [];
  private loaded = false;
  private kv: KVNamespace | null = null;

  /**
   * Initialize registry with KV namespace
   */
  async init(kv: KVNamespace): Promise<void> {
    this.kv = kv;
    await this.refresh();
  }

  /**
   * Refresh models from KV
   */
  async refresh(): Promise<void> {
    if (!this.kv) {
      this.models = getFallbackModels();
      this.loaded = true;
      return;
    }

    this.models = await getActiveModels(this.kv);
    this.loaded = true;
  }

  /**
   * Get all loaded models
   */
  getModels(): ModelProfile[] {
    if (!this.loaded) {
      return getFallbackModels();
    }
    return this.models;
  }

  /**
   * Check if registry is loaded
   */
  isLoaded(): boolean {
    return this.loaded;
  }

  /**
   * Get model count
   */
  getModelCount(): number {
    return this.models.length;
  }
}

// Singleton instance
let registryInstance: DynamicModelRegistry | null = null;

export function getRegistry(): DynamicModelRegistry {
  if (!registryInstance) {
    registryInstance = new DynamicModelRegistry();
  }
  return registryInstance;
}

// =============================================================================
// Ultimate Fallback - Never put on cooldown
// =============================================================================

export const ULTIMATE_FALLBACK = 'openai/gpt-4o-mini';

// =============================================================================
// Operation Configuration
// =============================================================================

export const OPERATION_CONFIG: Record<Operation, OperationConfig> = {
  'resume-parse': {
    requiredCapabilities: ['structured'],
    preferredModality: 'text_chat',
    description: 'Extract structured data from resumes',
    preferFast: true,
    enableCache: true,
  },
  'resume-parse-bulk': {
    requiredCapabilities: ['structured'],
    preferredModality: 'text_chat',
    description: 'Bulk resume parsing (cost-optimized, free-only)',
    preferFast: true,
    explorationRate: 0,           // No exploration for bulk
    forceFreeOnly: true,          // Force free tier
    maxRetries: 5,                // More retries on free models
    timeoutMs: 90000,             // 90s timeout
    enableCache: true,            // Enable semantic caching
    qualityThreshold: 0.70,       // Lower threshold for free models
  },
  'resume-cessr': {
    requiredCapabilities: ['reasoning'],
    preferredModality: 'text_chat',
    description: 'Deep career analysis using CESSR framework',
    minContextLength: 32000,
  },
  'interview-questions': {
    requiredCapabilities: ['creative'],
    preferredModality: 'text_chat',
    description: 'Generate relevant interview questions',
  },
  'interview-score': {
    requiredCapabilities: ['structured', 'reasoning'],
    preferredModality: 'text_chat',
    description: 'Score candidate responses consistently',
    preferFast: true,
  },
  'assessment': {
    requiredCapabilities: ['coding', 'reasoning'],
    preferredModality: 'text_chat',
    description: 'Technical skill assessment',
  },
  'match-report': {
    requiredCapabilities: ['reasoning', 'structured'],
    preferredModality: 'text_chat',
    description: 'Match candidates to jobs with explanations',
  },
  'job-parse': {
    requiredCapabilities: ['structured'],
    preferredModality: 'text_chat',
    description: 'Extract job requirements from postings',
    preferFast: true,
    enableCache: true,
  },
  'job-parse-bulk': {
    requiredCapabilities: ['structured'],
    preferredModality: 'text_chat',
    description: 'Bulk job parsing (cost-optimized, free-only)',
    preferFast: true,
    explorationRate: 0,           // No exploration for bulk
    forceFreeOnly: true,          // Force free tier
    maxRetries: 5,                // More retries on free models
    timeoutMs: 90000,             // 90s timeout
    enableCache: true,            // Enable semantic caching
    qualityThreshold: 0.70,       // Lower threshold for free models
  },
  'job-enrich': {
    requiredCapabilities: ['balanced'],
    preferredModality: 'text_chat',
    description: 'Enhance job data with industry context',
  },
  'generic': {
    requiredCapabilities: ['balanced'],
    preferredModality: 'text_chat',
    description: 'General purpose tasks',
  },
  // Talent Verification Operations
  'context-extraction': {
    requiredCapabilities: ['structured', 'reasoning'],
    preferredModality: 'text_chat',
    description: 'Extract skills, roles, experience from resume for assessment',
    preferFast: true,
  },
  'qualifying-questions': {
    requiredCapabilities: ['reasoning', 'creative'],
    preferredModality: 'text_chat',
    description: 'Generate role/skill clarification questions from resume context',
  },
  'arena-questions': {
    requiredCapabilities: ['reasoning', 'coding', 'structured'],
    preferredModality: 'text_chat',
    description: 'Generate skill assessment MCQ questions based on resume and role context',
    minContextLength: 16000,
  },
  'competency-scoring': {
    requiredCapabilities: ['reasoning', 'structured'],
    preferredModality: 'text_chat',
    description: 'Score open-ended competency responses with rubric',
    preferFast: true,
  },
  // Question Bank Operations
  'question-generate': {
    requiredCapabilities: ['reasoning', 'creative', 'structured'],
    preferredModality: 'text_chat',
    description: 'Generate MCQ questions for skill assessment',
    minContextLength: 8000,
  },
  'question-curate': {
    requiredCapabilities: ['reasoning', 'structured'],
    preferredModality: 'text_chat',
    description: 'Validate and grade generated questions with IRT parameters',
    preferFast: true,
  },
  // General test operation
  'test': {
    requiredCapabilities: ['balanced'],
    preferredModality: 'text_chat',
    description: 'General testing and debugging',
    preferFast: true,
  },
};

// =============================================================================
// Model Query Functions (use registry instance)
// =============================================================================

/**
 * Get models that match the required capabilities and modality
 */
export function getModelsForCapabilities(
  registry: DynamicModelRegistry,
  capabilities: Capability[],
  modality: Modality = 'text_chat',
  tier?: Tier
): ModelProfile[] {
  return registry.getModels().filter(model => {
    // Filter by tier if specified
    if (tier && model.tier !== tier) return false;
    
    // Must support the modality
    if (!model.modalities.includes(modality)) return false;
    
    // Must have at least one of the required capabilities
    const hasCapability = capabilities.some(cap => 
      model.capabilities.includes(cap)
    );
    
    return hasCapability;
  });
}

/**
 * Get models for a specific operation
 */
export function getModelsForOperation(
  registry: DynamicModelRegistry,
  operation: Operation,
  tier?: Tier
): ModelProfile[] {
  const config = OPERATION_CONFIG[operation];
  
  let models = getModelsForCapabilities(
    registry,
    config.requiredCapabilities,
    config.preferredModality,
    tier
  );
  
  // Apply context length filter if specified
  if (config.minContextLength) {
    models = models.filter(m => m.contextLength >= config.minContextLength!);
  }
  
  return models;
}

/**
 * Get all models for a tier
 */
export function getModelsByTier(registry: DynamicModelRegistry, tier: Tier): ModelProfile[] {
  return registry.getModels().filter(m => m.tier === tier);
}

/**
 * Get model profile by ID
 */
export function getModelById(registry: DynamicModelRegistry, id: string): ModelProfile | undefined {
  return registry.getModels().find(m => m.id === id);
}

/**
 * Check if a model ID is in the registry
 */
export function isKnownModel(registry: DynamicModelRegistry, id: string): boolean {
  return registry.getModels().some(m => m.id === id);
}

/**
 * Get all unique tiers in priority order
 */
export function getTierOrder(): Tier[] {
  return ['free', 'cheap', 'premium'];
}
