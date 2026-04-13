# OpenRouter Smart Router

An AI model discovery and routing tool for **Cloudflare Workers**. Discovers the best model for the right purpose, prioritizes the best free models first, and falls back to the highest-ranked lowest-price model. Built on OpenRouter with automatic failover and learning-based optimization.

## Features

- **Dynamic Model Discovery** - Discovers 50+ free models from OpenRouter every 24h via cron
- **Free-First Routing** - Always tries free models before cheap/premium tiers
- **Thompson Sampling** - Bayesian multi-armed bandit learns which models perform best per operation
- **Circuit Breaker** - Automatically stops routing to failing models
- **Semantic Caching** - Caches similar prompts via Workers AI embeddings (saves ~62% of calls)
- **Budget Guards** - Daily/monthly cost caps with automatic free-only fallback
- **Quality Feedback Loop** - Tracks success/failure per model per operation, improves over time
- **Benchmark-Based Selection** - Uses HumanEval, MMLU, GSM8K, and other benchmarks for intelligent model selection
- **API Key Management** - Built-in key generation, rate limiting, and usage tracking

## Architecture

```
Consumer Service
  -> RPC -> SmartRouterService
    -> Agentic Router (model selection from KV)
      -> Cloudflare AI Gateway
        -> OpenRouter
          -> Provider (OpenAI, Anthropic, Google, Meta, etc.)
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
# KV namespace for model state
npx wrangler kv:namespace create MODEL_STATE

# D1 database for benchmarks and usage logs
npx wrangler d1 create smart-router-db

# Apply migrations
npx wrangler d1 migrations apply smart-router-db --local
```

### 3. Configure wrangler.toml

Update the placeholder IDs in `wrangler.toml` with the values from step 2.

Set up an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) in your Cloudflare dashboard and update `AI_GATEWAY_ENDPOINT`.

### 4. Set secrets

```bash
npx wrangler secret put AI_GATEWAY_TOKEN
npx wrangler secret put OPENROUTER_API_KEY  # optional
```

### 5. Deploy

```bash
npx wrangler deploy
```

## Usage via RPC (Service Binding)

Other Cloudflare Workers can call this service via RPC:

```toml
# Consumer's wrangler.toml
[[services]]
binding = "AI_SERVICE"
service = "openrouter-smart-router"
entrypoint = "SmartRouterService"
```

```typescript
// Consumer code
const result = await env.AI_SERVICE.chat({
  operation: 'generic',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
  ],
});
```

## RPC Methods

| Method | Description |
|--------|-------------|
| `chat(request)` | Chat completion with agentic model selection |
| `intelligentChat(request)` | Benchmark-based model selection with use-case classification |
| `embed(inputs, model?)` | Generate embeddings via Workers AI |
| `getServiceHealth()` | Check if the router is healthy |

## HTTP Endpoints

The service also exposes HTTP endpoints for monitoring and admin:

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Quick health check |
| `GET /health/detailed` | Comprehensive health status |
| `GET /models` | List active models by tier |
| `GET /stats` | Router statistics (cache, budget, performance) |
| `GET /discovery/status` | Model discovery status |
| `POST /discovery/run` | Trigger manual model discovery |
| `GET /budget/status` | Current budget usage |
| `GET /quality/metrics` | Quality tracking metrics |
| `GET /circuits` | Circuit breaker status |

## How It Works

### Model Selection (Agentic Router)

1. Check semantic cache for similar previous requests
2. Check budget guards (switch to free-only if over budget)
3. Build tier order: `free -> cheap -> premium`
4. Within each tier, rank models using **Thompson Sampling** (learned from past success/failure)
5. Filter out models with open circuit breakers or active cooldowns
6. Try top-ranked model; on failure, apply progressive cooldown and try next
7. Cache successful responses for future similar requests

### Model Selection (Intelligent Router)

1. Classify the request by use case and complexity
2. Look up benchmark scores (HumanEval, MMLU, etc.) in D1
3. Select the cheapest model that meets the quality threshold
4. Automatic fallback with lower thresholds on failure

## License

MIT
