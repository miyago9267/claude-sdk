/**
 * Optimized Query -- Wrapped query() with automatic optimizations.
 *
 * Wraps the SDK's `query()` function to automatically:
 * 1. Apply cache optimizations to options
 * 2. Route to appropriate model based on task category
 * 3. Track token usage from results
 * 4. Inject context pruning via SubagentStart hooks
 * 5. Enforce token budgets
 *
 * Usage:
 *   import { createOptimizedQuery } from '@miyago/claude-sdk'
 *   const oq = createOptimizedQuery({ ... })
 *   const q = oq.query({ prompt: '...', options: { ... } })
 *   for await (const msg of q) { ... }
 */

import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type HookCallbackMatcher,
  type HookEvent,
  type SubagentStartHookInput,
  type HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk'

import { createContextPruner, type ContextPruner } from './context-pruner.js'
import { createModelRouter, type ModelRouter } from './model-router.js'
import { createTokenTracker, type TokenTracker } from './token-tracker.js'
import { createCacheOptimizer, type CacheOptimizer } from './cache-optimizer.js'
import type {
  OptimizedQueryConfig,
  OptimizedQueryParams,
  TokenReport,
} from './types.js'

export interface OptimizedQueryInstance {
  /** Execute an optimized query */
  query: (params: OptimizedQueryParams) => Query
  /** Get the token tracker for reporting */
  tracker: TokenTracker
  /** Get the model router */
  router: ModelRouter
  /** Get the context pruner */
  pruner: ContextPruner
  /** Get the cache optimizer */
  cacheOptimizer: CacheOptimizer
  /** Get current token report */
  getReport: () => TokenReport
  /** Check if budget is exceeded */
  isBudgetExceeded: () => boolean
}

/**
 * Create an optimized query wrapper around the SDK's query function.
 */
export function createOptimizedQuery(
  defaultConfig?: OptimizedQueryConfig,
): OptimizedQueryInstance {
  const pruner = createContextPruner(defaultConfig?.pruner)
  const router = createModelRouter(defaultConfig?.router)
  const tracker = createTokenTracker({
    ...defaultConfig?.tracker,
    onBudgetWarning: (report) => {
      defaultConfig?.onTokenWarning?.(report)
      defaultConfig?.tracker?.onBudgetWarning?.(report)
    },
    onBudgetExceeded: defaultConfig?.tracker?.onBudgetExceeded,
  })
  const cacheOptimizer = createCacheOptimizer(defaultConfig?.cache)

  function optimizedQuery(params: OptimizedQueryParams): Query {
    const { prompt, options = {}, optimization = {} } = params
    const mergedConfig = { ...defaultConfig, ...optimization }

    // Step 1: Model routing
    let resolvedOptions = { ...options }
    if (mergedConfig.taskCategory && !resolvedOptions.model) {
      const routing = router.route(mergedConfig.taskCategory)
      resolvedOptions.model = routing.model
      if (routing.effort && !resolvedOptions.effort) {
        resolvedOptions.effort = routing.effort
      }
    }

    // Step 2: Cache optimization
    resolvedOptions = cacheOptimizer.optimizeOptions(resolvedOptions)

    // Step 3: Budget enforcement via maxBudgetUsd
    if (mergedConfig.tokenBudgetUSD && !resolvedOptions.maxBudgetUsd) {
      resolvedOptions.maxBudgetUsd = mergedConfig.tokenBudgetUSD
    }

    // Step 4: Inject SubagentStart hook for context pruning
    const existingHooks = resolvedOptions.hooks ?? {}
    const subagentStartHooks: HookCallbackMatcher[] = [
      ...(existingHooks.SubagentStart ?? []),
      {
        hooks: [
          async (input, _toolUseID, _opts): Promise<HookJSONOutput> => {
            // SubagentStart hook: we can add context to the subagent
            const hookInput = input as SubagentStartHookInput
            return {
              hookSpecificOutput: {
                hookEventName: 'SubagentStart' as const,
                additionalContext: pruner.buildSubagentContext(
                  '', // No parent summary in this context
                  hookInput.agent_type ?? 'subagent',
                ),
              },
            }
          },
        ],
      },
    ]

    resolvedOptions.hooks = {
      ...existingHooks,
      SubagentStart: subagentStartHooks,
    }

    // Step 5: Execute the query
    const agentName = resolvedOptions.agent ?? 'main'
    const q = sdkQuery({ prompt, options: resolvedOptions })

    // Step 6: Wrap the async generator to intercept results
    return wrapQueryForTracking(q, agentName, tracker, cacheOptimizer)
  }

  return {
    query: optimizedQuery,
    tracker,
    router,
    pruner,
    cacheOptimizer,
    getReport: () => tracker.getReport(),
    isBudgetExceeded: () => tracker.isBudgetExceeded(),
  }
}

/**
 * Wrap a Query async generator to intercept result messages for tracking.
 *
 * Note: Query is an interface extending AsyncGenerator with additional methods.
 * We need to preserve those methods while intercepting the iteration.
 */
function wrapQueryForTracking(
  original: Query,
  agentName: string,
  tracker: TokenTracker,
  cacheOptimizer: CacheOptimizer,
): Query {
  // Create a proxy that intercepts iteration but delegates everything else
  const wrappedGenerator = (async function* () {
    for await (const message of original) {
      // Intercept result messages for token tracking
      if (message.type === 'result') {
        const resultMsg = message as SDKResultMessage
        tracker.recordUsage(agentName, resultMsg)
        cacheOptimizer.checkCacheHitRate(tracker.getReport())
      }
      yield message
    }
  })()

  // Build a proxy that combines the wrapped generator with original's methods
  const proxy = Object.create(wrappedGenerator) as Query

  // Delegate all Query-specific methods to the original
  proxy.interrupt = () => original.interrupt()
  proxy.setPermissionMode = (mode) => original.setPermissionMode(mode)
  proxy.setModel = (model) => original.setModel(model)
  proxy.setMaxThinkingTokens = (tokens) => original.setMaxThinkingTokens(tokens)
  proxy.initializationResult = () => original.initializationResult()
  proxy.supportedCommands = () => original.supportedCommands()
  proxy.supportedModels = () => original.supportedModels()
  proxy.supportedAgents = () => original.supportedAgents()
  proxy.mcpServerStatus = () => original.mcpServerStatus()
  proxy.accountInfo = () => original.accountInfo()
  proxy.rewindFiles = (id, opts) => original.rewindFiles(id, opts)
  proxy.reconnectMcpServer = (name) => original.reconnectMcpServer(name)
  proxy.toggleMcpServer = (name, enabled) => original.toggleMcpServer(name, enabled)
  proxy.setMcpServers = (servers) => original.setMcpServers(servers)
  proxy.streamInput = (stream) => original.streamInput(stream)
  proxy.stopTask = (taskId) => original.stopTask(taskId)
  proxy.close = () => original.close()

  // Ensure the proxy's iteration methods come from wrappedGenerator
  proxy.next = wrappedGenerator.next.bind(wrappedGenerator)
  proxy.return = wrappedGenerator.return.bind(wrappedGenerator)
  proxy.throw = wrappedGenerator.throw.bind(wrappedGenerator)
  proxy[Symbol.asyncIterator] = () => proxy

  return proxy
}
