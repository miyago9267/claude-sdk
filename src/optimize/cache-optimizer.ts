/**
 * Cache Optimizer -- Ensure prompt caching is used effectively.
 *
 * The SDK already uses Anthropic's prompt caching, but cache invalidation
 * can occur when:
 * 1. Tool definitions change order between calls
 * 2. System prompt varies (e.g., dynamic timestamps)
 * 3. Message history prefix changes
 *
 * This module provides utilities to maximize cache hits:
 * - Stabilize tool definition ordering
 * - Monitor cache hit rates from result messages
 * - Warn when cache performance degrades
 *
 * Limitation: We cannot directly mark content blocks as cacheable
 * (the SDK handles that internally). We focus on preventing
 * unnecessary cache invalidation.
 */

import type { CacheOptimizerConfig, TokenReport } from './types.js'
import { DEFAULT_CACHE_CONFIG } from './types.js'
import type { Options, AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

/**
 * Create a cache optimizer instance.
 */
export function createCacheOptimizer(userConfig?: Partial<CacheOptimizerConfig>) {
  const config: CacheOptimizerConfig = {
    ...DEFAULT_CACHE_CONFIG,
    ...userConfig,
  }

  /**
   * Stabilize tool definitions by sorting them alphabetically.
   * This prevents cache invalidation from tool ordering changes.
   *
   * When tools is a string array (tool names), sort alphabetically.
   * When tools is a preset object, leave as-is.
   */
  function stabilizeTools(
    tools: Options['tools'],
  ): Options['tools'] {
    if (!config.stabilizeToolOrder) return tools
    if (!tools) return tools
    if (!Array.isArray(tools)) return tools // preset object

    return [...tools].sort()
  }

  /**
   * Stabilize agent definitions by sorting their tool arrays.
   */
  function stabilizeAgentTools(
    agents: Record<string, AgentDefinition> | undefined,
  ): Record<string, AgentDefinition> | undefined {
    if (!agents || !config.stabilizeToolOrder) return agents

    const stabilized: Record<string, AgentDefinition> = {}
    for (const [name, definition] of Object.entries(agents)) {
      stabilized[name] = {
        ...definition,
        tools: definition.tools ? [...definition.tools].sort() : undefined,
        disallowedTools: definition.disallowedTools
          ? [...definition.disallowedTools].sort()
          : undefined,
      }
    }
    return stabilized
  }

  /**
   * Apply cache optimizations to SDK options.
   */
  function optimizeOptions(options: Options): Options {
    return {
      ...options,
      tools: stabilizeTools(options.tools),
      agents: stabilizeAgentTools(options.agents),
      allowedTools: options.allowedTools
        ? [...options.allowedTools].sort()
        : undefined,
      disallowedTools: options.disallowedTools
        ? [...options.disallowedTools].sort()
        : undefined,
    }
  }

  /**
   * Check cache hit rate and fire warning callback if below threshold.
   */
  function checkCacheHitRate(report: TokenReport): void {
    if (report.totalTurns < 2) return // Not enough data

    if (report.cacheHitRate < config.minCacheHitRate) {
      config.onLowCacheHitRate?.(report.cacheHitRate)
    }
  }

  return {
    stabilizeTools,
    stabilizeAgentTools,
    optimizeOptions,
    checkCacheHitRate,
    config,
  }
}

export type CacheOptimizer = ReturnType<typeof createCacheOptimizer>
