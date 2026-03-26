/**
 * Optimize utilities — model routing, context pruning, cache optimization, budget tracking.
 */

export { createContextPruner, estimateTokens } from './context-pruner.js'
export type { ContextPruner } from './context-pruner.js'

export { createModelRouter } from './model-router.js'
export type { ModelRouter, RoutingResult } from './model-router.js'

export { createTokenTracker } from './token-tracker.js'
export type { TokenTracker } from './token-tracker.js'

export { createCacheOptimizer } from './cache-optimizer.js'
export type { CacheOptimizer } from './cache-optimizer.js'

export { createOptimizedQuery } from './optimized-query.js'
export type { OptimizedQueryInstance } from './optimized-query.js'

export type {
  ContextPrunerConfig,
  ConversationTurn,
  PrunedContext,
  TaskCategory,
  ModelRoutingRule,
  ModelRouterConfig,
  TokenRecord,
  AgentTokenSummary,
  TokenTrackerConfig,
  TokenReport,
  CacheOptimizerConfig,
  OptimizedQueryConfig,
  OptimizedQueryParams,
  ModelPricing,
} from './types.js'

export {
  DEFAULT_PRUNER_CONFIG,
  DEFAULT_ROUTER_CONFIG,
  DEFAULT_TRACKER_CONFIG,
  DEFAULT_CACHE_CONFIG,
  MODEL_PRICING,
} from './types.js'
