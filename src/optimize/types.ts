/**
 * Shared type definitions for optimize utilities.
 */

import type {
  Options,
  SDKResultMessage,
  SDKMessage,
  ModelUsage,
  Query,
  AgentDefinition,
  HookCallback,
  HookCallbackMatcher,
} from '@anthropic-ai/claude-agent-sdk'

// ---------------------------------------------------------------------------
// Context Pruner
// ---------------------------------------------------------------------------

export interface ContextPrunerConfig {
  /** Maximum number of conversation turns to keep. Default: 10 */
  maxTurns: number
  /** Maximum estimated tokens for retained context. Default: 50_000 */
  maxTokens: number
  /** Number of turns after which older history is summarized. Default: 6 */
  summarizeAfter: number
  /** Model used for summarization (alias or full ID). Default: 'haiku' */
  summarizationModel: string
}

export const DEFAULT_PRUNER_CONFIG: ContextPrunerConfig = {
  maxTurns: 10,
  maxTokens: 50_000,
  summarizeAfter: 6,
  summarizationModel: 'haiku',
}

export interface ConversationTurn {
  role: 'user' | 'assistant'
  content: string
  tokenEstimate: number
}

export interface PrunedContext {
  /** Summary of dropped turns (empty if nothing was pruned) */
  summary: string
  /** Remaining turns after pruning */
  turns: ConversationTurn[]
  /** Total estimated tokens after pruning */
  totalTokens: number
  /** Number of turns dropped */
  droppedTurns: number
}

// ---------------------------------------------------------------------------
// Model Router
// ---------------------------------------------------------------------------

export type TaskCategory =
  | 'coordinator'
  | 'architect'
  | 'implementation'
  | 'validation'
  | 'classification'
  | 'summarization'
  | 'general'

export interface ModelRoutingRule {
  /** Task categories this rule applies to */
  categories: TaskCategory[]
  /** Model alias or full ID to use */
  model: string
  /** Optional effort level override */
  effort?: 'low' | 'medium' | 'high' | 'max'
}

export interface ModelRouterConfig {
  /** Default model when no rule matches */
  defaultModel: string
  /** Routing rules, checked in order */
  rules: ModelRoutingRule[]
}

export const DEFAULT_ROUTER_CONFIG: ModelRouterConfig = {
  defaultModel: 'claude-sonnet-4-6',
  rules: [
    {
      categories: ['coordinator', 'architect'],
      model: 'claude-opus-4-6',
      effort: 'high',
    },
    {
      categories: ['implementation'],
      model: 'claude-sonnet-4-6',
      effort: 'high',
    },
    {
      categories: ['validation', 'classification', 'summarization'],
      model: 'claude-haiku-4-5',
      effort: 'low',
    },
  ],
}

// ---------------------------------------------------------------------------
// Token Tracker
// ---------------------------------------------------------------------------

export interface TokenRecord {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUSD: number
  timestamp: number
}

export interface AgentTokenSummary {
  agentName: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUSD: number
  turnCount: number
  records: TokenRecord[]
}

export interface TokenTrackerConfig {
  /** Maximum total cost (USD) before warning fires. Default: 1.0 */
  budgetWarningUSD: number
  /** Maximum total cost (USD) before hard stop. Default: 5.0 */
  budgetLimitUSD: number
  /** Callback when budget warning threshold is reached */
  onBudgetWarning?: (summary: TokenReport) => void
  /** Callback when budget limit is exceeded */
  onBudgetExceeded?: (summary: TokenReport) => void
}

export const DEFAULT_TRACKER_CONFIG: TokenTrackerConfig = {
  budgetWarningUSD: 1.0,
  budgetLimitUSD: 5.0,
}

export interface TokenReport {
  agents: Record<string, AgentTokenSummary>
  byModel: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUSD: number
  }>
  totalCostUSD: number
  cacheHitRate: number
  totalTurns: number
}

// ---------------------------------------------------------------------------
// Cache Optimizer
// ---------------------------------------------------------------------------

export interface CacheOptimizerConfig {
  /** Sort tool definitions alphabetically for cache stability. Default: true */
  stabilizeToolOrder: boolean
  /** Minimum cache hit rate (0-1) before warning. Default: 0.5 */
  minCacheHitRate: number
  /** Callback when cache hit rate falls below threshold */
  onLowCacheHitRate?: (rate: number) => void
}

export const DEFAULT_CACHE_CONFIG: CacheOptimizerConfig = {
  stabilizeToolOrder: true,
  minCacheHitRate: 0.5,
}

// ---------------------------------------------------------------------------
// Optimized Query
// ---------------------------------------------------------------------------

export interface OptimizedQueryConfig {
  /** Context pruner configuration */
  pruner?: Partial<ContextPrunerConfig>
  /** Model router configuration */
  router?: Partial<ModelRouterConfig>
  /** Token tracker configuration */
  tracker?: Partial<TokenTrackerConfig>
  /** Cache optimizer configuration */
  cache?: Partial<CacheOptimizerConfig>
  /** Task category for model routing */
  taskCategory?: TaskCategory
  /** Token budget for this query (USD) */
  tokenBudgetUSD?: number
  /** Callback when token budget warning is triggered */
  onTokenWarning?: (report: TokenReport) => void
}

export interface OptimizedQueryParams {
  prompt: string
  options?: Options
  optimization?: OptimizedQueryConfig
}

// ---------------------------------------------------------------------------
// Pricing (per million tokens, as of 2026-03)
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheWritePerMillion: number
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-6': {
    inputPerMillion: 15,
    outputPerMillion: 75,
    cacheReadPerMillion: 1.5,
    cacheWritePerMillion: 18.75,
  },
  'claude-sonnet-4-6': {
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  'claude-haiku-4-5': {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
    cacheReadPerMillion: 0.08,
    cacheWritePerMillion: 1,
  },
}
