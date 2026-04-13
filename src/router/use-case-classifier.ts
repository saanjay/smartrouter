/**
 * Use Case Classifier
 * 
 * Classifies prompts into use cases and complexity levels
 * using keyword matching, pattern recognition, and D1-backed config.
 */

/// <reference types="@cloudflare/workers-types" />

// =============================================================================
// Types
// =============================================================================

export type UseCase = 'coding' | 'reasoning' | 'knowledge' | 'math' | 'creative' | 'instruction' | 'general';
export type Complexity = 'simple' | 'moderate' | 'complex';

export interface ClassificationResult {
  useCase: UseCase;
  confidence: number;        // 0-1
  complexity: Complexity;
  keywords: string[];        // Matched keywords
  secondaryUseCases: UseCase[];
}

export interface UseCaseConfig {
  use_case: UseCase;
  keywords: string[];
  patterns?: RegExp[];
  benchmark_weights: Record<string, number>;
  quality_threshold_simple: number;
  quality_threshold_moderate: number;
  quality_threshold_complex: number;
}

// =============================================================================
// Default Configuration (used if D1 is unavailable)
// =============================================================================

const DEFAULT_USE_CASE_CONFIG: Record<UseCase, UseCaseConfig> = {
  coding: {
    use_case: 'coding',
    keywords: ['code', 'coding', 'programming', 'debug', 'function', 'implement', 'algorithm', 'script', 'api', 'endpoint', 'typescript', 'javascript', 'python', 'sql', 'fix bug', 'refactor', 'test', 'class', 'method', 'variable', 'error', 'exception', 'compile', 'build'],
    patterns: [/```\w+/, /def\s+\w+/, /function\s+\w+/, /class\s+\w+/, /import\s+/, /const\s+\w+\s*=/, /let\s+\w+\s*=/],
    benchmark_weights: { bench_humaneval: 0.4, bench_mbpp: 0.3, score_coding: 0.3 },
    quality_threshold_simple: 50,
    quality_threshold_moderate: 70,
    quality_threshold_complex: 85,
  },
  reasoning: {
    use_case: 'reasoning',
    keywords: ['reason', 'analyze', 'think', 'explain why', 'logic', 'deduce', 'infer', 'evaluate', 'compare', 'contrast', 'pros and cons', 'decision', 'strategy', 'because', 'therefore', 'however', 'although', 'implications', 'consequences'],
    patterns: [/why\s+(does|is|do|are|would|should)/i, /what\s+if/i, /how\s+would/i],
    benchmark_weights: { bench_arc: 0.3, bench_gsm8k: 0.2, score_reasoning: 0.5 },
    quality_threshold_simple: 55,
    quality_threshold_moderate: 72,
    quality_threshold_complex: 88,
  },
  knowledge: {
    use_case: 'knowledge',
    keywords: ['what is', 'define', 'explain', 'describe', 'tell me about', 'information', 'facts', 'history', 'science', 'geography', 'who', 'when', 'where', 'meaning', 'definition', 'concept'],
    patterns: [/^what\s+(is|are)/i, /^who\s+(is|was|are|were)/i, /^when\s+(did|was|is)/i, /^where\s+(is|are|was)/i],
    benchmark_weights: { bench_mmlu: 0.5, score_knowledge: 0.5 },
    quality_threshold_simple: 50,
    quality_threshold_moderate: 65,
    quality_threshold_complex: 80,
  },
  math: {
    use_case: 'math',
    keywords: ['calculate', 'compute', 'solve', 'equation', 'formula', 'math', 'arithmetic', 'algebra', 'geometry', 'statistics', 'probability', 'number', 'percent', 'fraction', 'decimal', 'multiply', 'divide', 'add', 'subtract', 'derivative', 'integral'],
    patterns: [/\d+\s*[\+\-\*\/\^]\s*\d+/, /\d+%/, /\$\d+/, /=\s*\?/],
    benchmark_weights: { bench_gsm8k: 0.3, bench_math: 0.4, score_math: 0.3 },
    quality_threshold_simple: 55,
    quality_threshold_moderate: 75,
    quality_threshold_complex: 90,
  },
  creative: {
    use_case: 'creative',
    keywords: ['write', 'create', 'generate', 'story', 'poem', 'email', 'letter', 'content', 'blog', 'article', 'creative', 'imagine', 'brainstorm', 'draft', 'compose', 'narrative', 'fiction', 'dialogue'],
    patterns: [/write\s+(a|an|me)/i, /create\s+(a|an)/i, /generate\s+(a|an)/i],
    benchmark_weights: { bench_mt_bench: 0.4, score_creative: 0.6 },
    quality_threshold_simple: 45,
    quality_threshold_moderate: 60,
    quality_threshold_complex: 75,
  },
  instruction: {
    use_case: 'instruction',
    keywords: ['how to', 'steps to', 'guide', 'instructions', 'tutorial', 'process', 'workflow', 'procedure', 'walk me through', 'show me how', 'teach me'],
    patterns: [/^how\s+(do|can|to)/i, /step\s*by\s*step/i, /^show\s+me/i],
    benchmark_weights: { bench_ifeval: 0.5, score_instruction: 0.5 },
    quality_threshold_simple: 50,
    quality_threshold_moderate: 68,
    quality_threshold_complex: 82,
  },
  general: {
    use_case: 'general',
    keywords: ['help', 'assist', 'chat', 'question', 'answer', 'hi', 'hello', 'hey', 'thanks', 'please'],
    patterns: [],
    benchmark_weights: { score_overall: 1.0 },
    quality_threshold_simple: 45,
    quality_threshold_moderate: 60,
    quality_threshold_complex: 75,
  },
};

// =============================================================================
// Complexity Indicators
// =============================================================================

const COMPLEXITY_INDICATORS = {
  simple: {
    keywords: ['simple', 'basic', 'quick', 'short', 'brief', 'easy', 'straightforward'],
    maxTokens: 50,
    maxSentences: 2,
  },
  complex: {
    keywords: ['complex', 'detailed', 'comprehensive', 'in-depth', 'thorough', 'advanced', 'expert', 'production', 'enterprise', 'scalable', 'optimize', 'architecture'],
    minTokens: 200,
    hasCodeBlocks: true,
    hasMultipleQuestions: true,
  },
};

// =============================================================================
// Use Case Classifier Class
// =============================================================================

export class UseCaseClassifier {
  private config: Record<UseCase, UseCaseConfig>;
  private db: D1Database | null;

  constructor(db?: D1Database) {
    this.config = DEFAULT_USE_CASE_CONFIG;
    this.db = db || null;
  }

  /**
   * Load configuration from D1 database
   */
  async loadConfig(): Promise<void> {
    if (!this.db) return;

    try {
      const result = await this.db.prepare(
        'SELECT * FROM use_case_config'
      ).all<{
        use_case: string;
        keywords: string;
        patterns: string | null;
        benchmark_weights: string;
        quality_threshold_simple: number;
        quality_threshold_moderate: number;
        quality_threshold_complex: number;
      }>();

      if (result.results && result.results.length > 0) {
        for (const row of result.results) {
          const useCase = row.use_case as UseCase;
          if (this.config[useCase]) {
            this.config[useCase] = {
              use_case: useCase,
              keywords: JSON.parse(row.keywords),
              patterns: row.patterns ? JSON.parse(row.patterns).map((p: string) => new RegExp(p, 'i')) : [],
              benchmark_weights: JSON.parse(row.benchmark_weights),
              quality_threshold_simple: row.quality_threshold_simple,
              quality_threshold_moderate: row.quality_threshold_moderate,
              quality_threshold_complex: row.quality_threshold_complex,
            };
          }
        }
      }
    } catch (error) {
      console.error('Failed to load use case config from D1:', error);
      // Fall back to defaults
    }
  }

  /**
   * Classify a prompt into a use case and complexity
   */
  classify(prompt: string, systemPrompt?: string): ClassificationResult {
    const combinedText = `${systemPrompt || ''} ${prompt}`.toLowerCase();
    const scores: Record<UseCase, { score: number; keywords: string[] }> = {
      coding: { score: 0, keywords: [] },
      reasoning: { score: 0, keywords: [] },
      knowledge: { score: 0, keywords: [] },
      math: { score: 0, keywords: [] },
      creative: { score: 0, keywords: [] },
      instruction: { score: 0, keywords: [] },
      general: { score: 0, keywords: [] },
    };

    // Score each use case
    for (const [useCase, config] of Object.entries(this.config)) {
      const uc = useCase as UseCase;
      
      // Keyword matching
      for (const keyword of config.keywords) {
        if (combinedText.includes(keyword.toLowerCase())) {
          scores[uc].score += 1;
          scores[uc].keywords.push(keyword);
        }
      }

      // Pattern matching (weighted higher)
      if (config.patterns) {
        for (const pattern of config.patterns) {
          if (pattern.test(combinedText)) {
            scores[uc].score += 2;
          }
        }
      }
    }

    // Find the best matching use case
    let bestUseCase: UseCase = 'general';
    let bestScore = 0;
    let totalScore = 0;

    for (const [useCase, data] of Object.entries(scores)) {
      totalScore += data.score;
      if (data.score > bestScore) {
        bestScore = data.score;
        bestUseCase = useCase as UseCase;
      }
    }

    // Calculate confidence
    const confidence = totalScore > 0 ? bestScore / totalScore : 0.5;

    // Find secondary use cases (score > 50% of best)
    const secondaryUseCases: UseCase[] = [];
    for (const [useCase, data] of Object.entries(scores)) {
      if (useCase !== bestUseCase && data.score > bestScore * 0.5) {
        secondaryUseCases.push(useCase as UseCase);
      }
    }

    // Determine complexity
    const complexity = this.classifyComplexity(prompt, combinedText);

    return {
      useCase: bestUseCase,
      confidence,
      complexity,
      keywords: scores[bestUseCase].keywords,
      secondaryUseCases,
    };
  }

  /**
   * Classify complexity based on prompt characteristics
   */
  private classifyComplexity(prompt: string, normalizedText: string): Complexity {
    // Check for explicit complexity indicators
    for (const keyword of COMPLEXITY_INDICATORS.complex.keywords) {
      if (normalizedText.includes(keyword)) {
        return 'complex';
      }
    }

    for (const keyword of COMPLEXITY_INDICATORS.simple.keywords) {
      if (normalizedText.includes(keyword)) {
        return 'simple';
      }
    }

    // Heuristic-based complexity
    const wordCount = prompt.split(/\s+/).length;
    const hasCodeBlocks = /```/.test(prompt);
    const hasMultipleQuestions = (prompt.match(/\?/g) || []).length > 1;
    const hasBulletPoints = /^[-*•]\s/m.test(prompt);
    const hasNumberedList = /^\d+\.\s/m.test(prompt);

    let complexityScore = 0;

    // Word count factor
    if (wordCount > 200) complexityScore += 2;
    else if (wordCount > 100) complexityScore += 1;
    else if (wordCount < 20) complexityScore -= 1;

    // Structure factors
    if (hasCodeBlocks) complexityScore += 2;
    if (hasMultipleQuestions) complexityScore += 1;
    if (hasBulletPoints || hasNumberedList) complexityScore += 1;

    // Determine complexity from score
    if (complexityScore >= 3) return 'complex';
    if (complexityScore <= -1) return 'simple';
    return 'moderate';
  }

  /**
   * Get quality threshold for a use case and complexity
   */
  getQualityThreshold(useCase: UseCase, complexity: Complexity): number {
    const config = this.config[useCase];
    switch (complexity) {
      case 'simple':
        return config.quality_threshold_simple;
      case 'moderate':
        return config.quality_threshold_moderate;
      case 'complex':
        return config.quality_threshold_complex;
    }
  }

  /**
   * Get benchmark weights for a use case
   */
  getBenchmarkWeights(useCase: UseCase): Record<string, number> {
    return this.config[useCase].benchmark_weights;
  }
}
