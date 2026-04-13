/**
 * Dynamic Model Discovery
 * 
 * Fetches models from OpenRouter API, validates them, and stores in KV.
 * Runs every 24 hours via cron trigger.
 */

/// <reference types="@cloudflare/workers-types" />

import type { ModelProfile, Capability, Tier, Modality } from './types';

// =============================================================================
// Types
// =============================================================================

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  top_provider?: {
    is_moderated?: boolean;
  };
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

interface DiscoveryEnv {
  MODEL_STATE: KVNamespace;
  AI_GATEWAY_ENDPOINT: string;
  AI_GATEWAY_TOKEN: string;
  OPENROUTER_API_KEY?: string;
}

interface DiscoveryResult {
  discovered: number;
  validated: number;
  failed: number;
  models: ModelProfile[];
  errors: string[];
}

// =============================================================================
// KV Keys
// =============================================================================

const KV_KEYS = {
  ACTIVE_MODELS: 'models:active',
  COOLED_MODELS: 'models:cooled',
  LAST_DISCOVERY: 'models:last_discovery',
  DISCOVERY_LOG: 'models:discovery_log',
} as const;

// =============================================================================
// Capability Inference - Multi-Signal Approach
// =============================================================================

// Keyword patterns for each capability with weights
const CAPABILITY_PATTERNS: Record<Capability, { keywords: string[]; weight: number }[]> = {
  coding: [
    { keywords: ['code', 'coder', 'coding'], weight: 3 },
    { keywords: ['programming', 'developer', 'software'], weight: 2 },
    { keywords: ['swe-bench', 'humaneval', 'mbpp'], weight: 3 },
    { keywords: ['ide', 'agentic workflow'], weight: 2 },
    { keywords: ['deepseek', 'starcoder', 'codestral', 'devstral', 'wizard'], weight: 2 },
    { keywords: ['function calling', 'tool use'], weight: 1 },
  ],
  reasoning: [
    { keywords: ['reason', 'reasoning'], weight: 3 },
    { keywords: ['think', 'thinking', 'thought'], weight: 3 },
    { keywords: ['analysis', 'analytical', 'logic'], weight: 2 },
    { keywords: ['math', 'mathematical', 'gsm8k'], weight: 2 },
    { keywords: ['o1', 'r1', 'think'], weight: 3 },
    { keywords: ['deep thinking', 'chain of thought', 'step by step'], weight: 2 },
    { keywords: ['problem solving', 'complex'], weight: 1 },
  ],
  creative: [
    { keywords: ['creative', 'creativity'], weight: 3 },
    { keywords: ['writing', 'writer', 'content'], weight: 2 },
    { keywords: ['story', 'narrative', 'fiction'], weight: 2 },
    { keywords: ['generate', 'generation'], weight: 1 },
    { keywords: ['chat', 'conversation', 'assistant'], weight: 1 },
    { keywords: ['instruct', 'helpful'], weight: 1 },
  ],
  structured: [
    { keywords: ['json', 'structured output'], weight: 3 },
    { keywords: ['extract', 'extraction'], weight: 2 },
    { keywords: ['parse', 'parsing'], weight: 2 },
    { keywords: ['format', 'formatting'], weight: 1 },
    { keywords: ['gpt-4', 'claude', 'gemini', 'llama-3', 'qwen'], weight: 2 },
    { keywords: ['function calling', 'tool use'], weight: 2 },
  ],
  vision: [
    { keywords: ['vision', 'visual', 'image'], weight: 3 },
    { keywords: ['multimodal', 'multi-modal'], weight: 3 },
    { keywords: ['picture', 'photo', 'ocr'], weight: 2 },
    { keywords: ['4o', 'gemma-3', 'llava', 'pixtral'], weight: 2 },
  ],
  balanced: [
    { keywords: ['general', 'general-purpose', 'versatile'], weight: 2 },
    { keywords: ['all-around', 'multipurpose'], weight: 2 },
    { keywords: ['assistant', 'helpful'], weight: 1 },
  ],
};

// Known high-quality models for specific tasks (curated list)
// EXPANDED for 2.0: Added free models and more variants
const KNOWN_QUALITY_MODELS: Record<string, Capability[]> = {
  // ============== FREE TIER PRIORITY ==============
  // OpenRouter Special Models - FREE (Claude Opus level!)
  'openrouter/pony-alpha': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  'openrouter/aurora-alpha': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  'openrouter/free': ['structured', 'reasoning', 'balanced'],
  // X.AI (Grok) - FREE
  'x-ai/grok-2-1212:free': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  'x-ai/grok-3-mini-beta:free': ['structured', 'reasoning', 'coding', 'balanced'],
  'x-ai/grok-3-beta:free': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  // Google FREE
  'google/gemini-2.0-flash:free': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  'google/gemini-2.0-flash-lite:free': ['structured', 'reasoning', 'creative', 'balanced'],
  'google/gemini-exp-1206:free': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  // Meta FREE
  'meta-llama/llama-3.3-70b-instruct:free': ['structured', 'reasoning', 'creative', 'balanced'],
  'meta-llama/llama-3.1-8b-instruct:free': ['structured', 'creative', 'balanced'],
  'meta-llama/llama-3.2-3b-instruct:free': ['structured', 'balanced'],
  // Qwen FREE
  'qwen/qwen-2.5-72b-instruct:free': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  'qwen/qwen-2.5-coder-32b-instruct:free': ['coding', 'reasoning', 'structured'],
  'qwen/qwq-32b:free': ['reasoning', 'coding', 'structured'],
  // DeepSeek FREE
  'deepseek/deepseek-r1:free': ['reasoning', 'coding', 'structured'],
  'deepseek/deepseek-chat:free': ['reasoning', 'coding', 'structured', 'balanced'],
  'deepseek/deepseek-r1-distill-llama-70b:free': ['reasoning', 'coding', 'structured'],
  // Mistral FREE
  'mistralai/mistral-7b-instruct:free': ['structured', 'creative', 'balanced'],
  'mistralai/mistral-small-3.1-24b-instruct:free': ['structured', 'reasoning', 'balanced'],
  // Microsoft FREE
  'microsoft/phi-4:free': ['reasoning', 'coding', 'structured'],
  'microsoft/phi-3-medium-128k-instruct:free': ['reasoning', 'structured', 'balanced'],
  // Nous FREE
  'nousresearch/hermes-3-llama-3.1-405b:free': ['reasoning', 'creative', 'balanced'],
  // Google Gemma FREE
  'google/gemma-3-27b-it:free': ['structured', 'reasoning', 'balanced'],
  'google/gemma-2-9b-it:free': ['structured', 'balanced'],
  
  // ============== PAID TIER (Reference) ==============
  // OpenAI
  'openai/gpt-4o': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  'openai/gpt-4o-mini': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  'openai/o1': ['reasoning', 'coding', 'structured'],
  'openai/o1-mini': ['reasoning', 'coding', 'structured'],
  'openai/o3-mini': ['reasoning', 'coding', 'structured'],
  // Anthropic
  'anthropic/claude-3.5-sonnet': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  'anthropic/claude-3-haiku': ['structured', 'reasoning', 'creative', 'balanced'],
  'anthropic/claude-sonnet-4': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  // Google
  'google/gemini-2.0-flash': ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
  'google/gemini-pro': ['structured', 'reasoning', 'creative', 'balanced'],
  // DeepSeek
  'deepseek/deepseek-chat': ['reasoning', 'coding', 'structured', 'balanced'],
  'deepseek/deepseek-coder': ['coding', 'reasoning', 'structured'],
  'deepseek/deepseek-r1': ['reasoning', 'coding', 'structured'],
  // Meta
  'meta-llama/llama-3.3-70b-instruct': ['structured', 'reasoning', 'creative', 'balanced'],
  'meta-llama/llama-3.1-70b-instruct': ['structured', 'reasoning', 'creative', 'balanced'],
  // Qwen
  'qwen/qwen-2.5-coder-32b-instruct': ['coding', 'reasoning', 'structured'],
  'qwen/qwen-2.5-72b-instruct': ['structured', 'reasoning', 'creative', 'coding', 'balanced'],
  'qwen/qwq-32b': ['reasoning', 'coding', 'structured'],
  // Mistral
  'mistralai/mistral-large': ['structured', 'reasoning', 'creative', 'balanced'],
  'mistralai/codestral': ['coding', 'structured'],
};

function inferCapabilities(model: OpenRouterModel): Capability[] {
  const capabilities: Set<Capability> = new Set();
  const id = model.id.toLowerCase();
  const name = (model.name || '').toLowerCase();
  const desc = (model.description || '').toLowerCase();
  const combined = `${id} ${name} ${desc}`;

  // 1. Check known quality models first (exact or partial match)
  for (const [knownId, knownCaps] of Object.entries(KNOWN_QUALITY_MODELS)) {
    if (id.includes(knownId.toLowerCase()) || knownId.toLowerCase().includes(id.split(':')[0])) {
      knownCaps.forEach(cap => capabilities.add(cap));
      return Array.from(capabilities);
    }
  }

  // 2. Score-based capability inference
  const scores: Record<Capability, number> = {
    coding: 0,
    reasoning: 0,
    creative: 0,
    structured: 0,
    vision: 0,
    balanced: 0,
  };

  for (const [capability, patterns] of Object.entries(CAPABILITY_PATTERNS)) {
    for (const pattern of patterns) {
      for (const keyword of pattern.keywords) {
        if (combined.includes(keyword.toLowerCase())) {
          scores[capability as Capability] += pattern.weight;
        }
      }
    }
  }

  // 3. Architecture-based inference
  if (model.architecture?.input_modalities?.includes('image')) {
    scores.vision += 5;
  }
  if (model.architecture?.modality?.includes('image')) {
    scores.vision += 3;
  }

  // 4. Add capabilities that exceed threshold
  const THRESHOLD = 2;
  for (const [capability, score] of Object.entries(scores)) {
    if (score >= THRESHOLD) {
      capabilities.add(capability as Capability);
    }
  }

  // 5. Ensure minimum capabilities
  // Large context models are good for reasoning
  if (model.context_length >= 100000 && !capabilities.has('reasoning')) {
    capabilities.add('reasoning');
  }

  // Most modern instruct models can do structured output
  if ((combined.includes('instruct') || combined.includes('chat')) && !capabilities.has('structured')) {
    capabilities.add('structured');
  }

  // Default to balanced if no strong signals
  if (capabilities.size === 0) {
    capabilities.add('balanced');
  }

  // All chat/instruct models should be able to do creative tasks
  if (combined.includes('instruct') || combined.includes('chat')) {
    capabilities.add('creative');
    capabilities.add('balanced');
  }

  return Array.from(capabilities);
}

// =============================================================================
// Tier Classification
// =============================================================================

function classifyTier(model: OpenRouterModel): Tier {
  const promptPrice = parseFloat(model.pricing.prompt);
  
  if (promptPrice === 0 || model.id.endsWith(':free')) {
    return 'free';
  }
  
  // Price per 1M tokens
  const pricePerMillion = promptPrice * 1_000_000;
  
  if (pricePerMillion < 1) {
    return 'cheap';
  }
  
  return 'premium';
}

// =============================================================================
// Modality Detection
// =============================================================================

function detectModalities(model: OpenRouterModel): Modality[] {
  const modalities: Modality[] = ['text_chat'];
  
  if (
    model.architecture?.input_modalities?.includes('image') ||
    model.id.toLowerCase().includes('vision') ||
    model.id.includes('4o') ||
    model.id.includes('gemma-3') ||
    model.id.includes('llava') ||
    model.id.includes('pixtral')
  ) {
    modalities.push('vision_chat');
  }
  
  return modalities;
}

// =============================================================================
// Model Validation
// =============================================================================

async function validateModel(
  model: ModelProfile,
  env: DiscoveryEnv
): Promise<{ valid: boolean; error?: string }> {
  try {
    const response = await fetch(`${env.AI_GATEWAY_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cf-aig-authorization': `Bearer ${env.AI_GATEWAY_TOKEN}`,
        'cf-aig-metadata': JSON.stringify({
          service: 'smart-router-discovery',
          operation: 'model-validation',
          model: model.id,
        }),
      },
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 5,
        temperature: 0,
      }),
    });

    if (response.ok) {
      return { valid: true };
    }

    const errorText = await response.text();
    return { 
      valid: false, 
      error: `HTTP ${response.status}: ${errorText.slice(0, 100)}` 
    };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// =============================================================================
// Main Discovery Function
// =============================================================================

export async function discoverModels(env: DiscoveryEnv): Promise<DiscoveryResult> {
  const result: DiscoveryResult = {
    discovered: 0,
    validated: 0,
    failed: 0,
    models: [],
    errors: [],
  };

  try {
    // Fetch models from OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'HTTP-Referer': 'https://github.com/openrouter-smart-router',
        'X-Title': 'Smart Router',
        ...(env.OPENROUTER_API_KEY && {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        }),
      },
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.status}`);
    }

    const data = await response.json() as { data: OpenRouterModel[] };
    result.discovered = data.data.length;

    // Filter and convert models
    const candidates: ModelProfile[] = [];
    
    for (const model of data.data) {
      // Skip models without pricing info
      if (!model.pricing?.prompt) continue;
      
      // Skip very short context models
      if (model.context_length < 4096) continue;
      
      // Skip moderated/restricted models
      if (model.top_provider?.is_moderated) continue;

      const tier = classifyTier(model);
      const capabilities = inferCapabilities(model);
      const modalities = detectModalities(model);

      candidates.push({
        id: model.id,
        tier,
        capabilities,
        modalities,
        contextLength: model.context_length,
        supportsStructuredOutput: capabilities.includes('structured'),
        provider: model.id.split('/')[0],
      });
    }

    // Sort by tier priority: free first, then cheap, then premium
    const tierOrder: Record<Tier, number> = { free: 0, cheap: 1, premium: 2 };
    candidates.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

    // Validate models (limit concurrent validations)
    const validatedModels: ModelProfile[] = [];
    const BATCH_SIZE = 10;   // Increased batch size for faster validation
    const MAX_FREE = 50;      // Validate up to 50 free models (3x increase)
    const MAX_CHEAP = 25;     // Validate up to 25 cheap models (2.5x increase)
    const MAX_PREMIUM = 10;   // Validate up to 10 premium models (2x increase)

    const freeModels = candidates.filter(m => m.tier === 'free').slice(0, MAX_FREE);
    const cheapModels = candidates.filter(m => m.tier === 'cheap').slice(0, MAX_CHEAP);
    const premiumModels = candidates.filter(m => m.tier === 'premium').slice(0, MAX_PREMIUM);
    
    const toValidate = [...freeModels, ...cheapModels, ...premiumModels];

    for (let i = 0; i < toValidate.length; i += BATCH_SIZE) {
      const batch = toValidate.slice(i, i + BATCH_SIZE);
      const validations = await Promise.all(
        batch.map(async (model) => {
          const validation = await validateModel(model, env);
          return { model, validation };
        })
      );

      for (const { model, validation } of validations) {
        if (validation.valid) {
          validatedModels.push(model);
          result.validated++;
        } else {
          result.failed++;
          result.errors.push(`${model.id}: ${validation.error}`);
        }
      }

      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < toValidate.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    result.models = validatedModels;

    // Store in KV
    await env.MODEL_STATE.put(
      KV_KEYS.ACTIVE_MODELS,
      JSON.stringify(validatedModels),
      { expirationTtl: 60 * 60 * 72 } // 72 hours TTL (3x buffer for 24h refresh)
    );

    await env.MODEL_STATE.put(
      KV_KEYS.LAST_DISCOVERY,
      JSON.stringify({
        timestamp: Date.now(),
        discovered: result.discovered,
        validated: result.validated,
        failed: result.failed,
      })
    );

    // Log discovery result
    const logEntry = {
      timestamp: new Date().toISOString(),
      discovered: result.discovered,
      validated: result.validated,
      failed: result.failed,
      topErrors: result.errors.slice(0, 5),
    };
    await env.MODEL_STATE.put(KV_KEYS.DISCOVERY_LOG, JSON.stringify(logEntry));

  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Discovery failed');
  }

  return result;
}

// =============================================================================
// Get Active Models from KV
// =============================================================================

export async function getActiveModels(kv: KVNamespace): Promise<ModelProfile[]> {
  const cached = await kv.get(KV_KEYS.ACTIVE_MODELS);
  
  if (cached) {
    try {
      return JSON.parse(cached) as ModelProfile[];
    } catch {
      // Fall through to fallback
    }
  }

  // Return minimal fallback if KV is empty
  return getFallbackModels();
}

// =============================================================================
// Fallback Models (Only used if discovery completely fails)
// =============================================================================

export function getFallbackModels(): ModelProfile[] {
  return [
    {
      id: 'openai/gpt-4o-mini',
      tier: 'cheap',
      capabilities: ['structured', 'reasoning', 'creative', 'coding', 'vision', 'balanced'],
      modalities: ['text_chat', 'vision_chat'],
      contextLength: 128000,
      supportsStructuredOutput: true,
      provider: 'openai',
    },
  ];
}

// =============================================================================
// Get Discovery Status
// =============================================================================

export async function getDiscoveryStatus(kv: KVNamespace): Promise<{
  lastDiscovery: number | null;
  activeModelCount: number;
  status: 'healthy' | 'stale' | 'failed';
}> {
  const lastDiscoveryStr = await kv.get(KV_KEYS.LAST_DISCOVERY);
  const activeModels = await getActiveModels(kv);
  
  let lastDiscovery: number | null = null;
  if (lastDiscoveryStr) {
    try {
      const parsed = JSON.parse(lastDiscoveryStr);
      lastDiscovery = parsed.timestamp;
    } catch {
      // Ignore parse errors
    }
  }

  const now = Date.now();
  const staleThreshold = 25 * 60 * 60 * 1000; // 25 hours
  
  let status: 'healthy' | 'stale' | 'failed' = 'healthy';
  
  if (!lastDiscovery || activeModels.length === 0) {
    status = 'failed';
  } else if (now - lastDiscovery > staleThreshold) {
    status = 'stale';
  }

  return {
    lastDiscovery,
    activeModelCount: activeModels.length,
    status,
  };
}

// =============================================================================
// Export KV Keys for external use
// =============================================================================

export { KV_KEYS };
