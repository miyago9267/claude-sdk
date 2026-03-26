/**
 * Token Tracker -- Per-agent token consumption tracking and cost calculation.
 *
 * Tracks token usage from SDK result messages and provides:
 * - Per-agent cost breakdown
 * - Per-model cost breakdown
 * - Cache hit rate monitoring
 * - Budget warnings and limits
 */

import type {
  TokenTrackerConfig,
  TokenRecord,
  AgentTokenSummary,
  TokenReport,
  ModelPricing,
} from './types.js'
import {
  DEFAULT_TRACKER_CONFIG,
  MODEL_PRICING,
} from './types.js'
import type { SDKResultMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Create a token tracker instance.
 */
export function createTokenTracker(userConfig?: Partial<TokenTrackerConfig>) {
  const config: TokenTrackerConfig = {
    ...DEFAULT_TRACKER_CONFIG,
    ...userConfig,
  }

  const agentRecords = new Map<string, TokenRecord[]>()
  let warningFired = false
  let limitFired = false

  /**
   * Record token usage from an SDK result message.
   */
  function recordUsage(agentName: string, result: SDKResultMessage): void {
    const modelUsage = result.modelUsage

    for (const [model, usage] of Object.entries(modelUsage)) {
      const record: TokenRecord = {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadInputTokens,
        cacheCreationTokens: usage.cacheCreationInputTokens,
        costUSD: usage.costUSD,
        timestamp: Date.now(),
      }

      const existing = agentRecords.get(agentName) ?? []
      existing.push(record)
      agentRecords.set(agentName, existing)
    }

    // Check budget thresholds
    const report = getReport()
    if (!warningFired && report.totalCostUSD >= config.budgetWarningUSD) {
      warningFired = true
      config.onBudgetWarning?.(report)
    }
    if (!limitFired && report.totalCostUSD >= config.budgetLimitUSD) {
      limitFired = true
      config.onBudgetExceeded?.(report)
    }
  }

  /**
   * Calculate cost for a token record using pricing table.
   */
  function calculateCost(record: TokenRecord): number {
    const pricing = findPricing(record.model)
    if (!pricing) return record.costUSD // Fallback to SDK-reported cost

    return (
      (record.inputTokens * pricing.inputPerMillion) / 1_000_000 +
      (record.outputTokens * pricing.outputPerMillion) / 1_000_000 +
      (record.cacheReadTokens * pricing.cacheReadPerMillion) / 1_000_000 +
      (record.cacheCreationTokens * pricing.cacheWritePerMillion) / 1_000_000
    )
  }

  /**
   * Find pricing for a model, supporting partial matches.
   */
  function findPricing(model: string): ModelPricing | undefined {
    // Direct match
    if (MODEL_PRICING[model]) return MODEL_PRICING[model]

    // Partial match (e.g. 'opus' matches 'claude-opus-4-6')
    for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
      if (key.includes(model) || model.includes(key)) return pricing
    }

    return undefined
  }

  /**
   * Get agent summary for a specific agent.
   */
  function getAgentSummary(agentName: string): AgentTokenSummary {
    const records = agentRecords.get(agentName) ?? []
    return {
      agentName,
      totalInputTokens: records.reduce((s, r) => s + r.inputTokens, 0),
      totalOutputTokens: records.reduce((s, r) => s + r.outputTokens, 0),
      totalCacheReadTokens: records.reduce((s, r) => s + r.cacheReadTokens, 0),
      totalCacheCreationTokens: records.reduce((s, r) => s + r.cacheCreationTokens, 0),
      totalCostUSD: records.reduce((s, r) => s + r.costUSD, 0),
      turnCount: records.length,
      records,
    }
  }

  /**
   * Get comprehensive token usage report.
   */
  function getReport(): TokenReport {
    const agents: Record<string, AgentTokenSummary> = {}
    const byModel: Record<string, {
      inputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheCreationTokens: number
      costUSD: number
    }> = {}

    let totalCostUSD = 0
    let totalInputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreationTokens = 0
    let totalTurns = 0

    for (const [agentName] of agentRecords) {
      const summary = getAgentSummary(agentName)
      agents[agentName] = summary
      totalCostUSD += summary.totalCostUSD
      totalInputTokens += summary.totalInputTokens
      totalCacheReadTokens += summary.totalCacheReadTokens
      totalCacheCreationTokens += summary.totalCacheCreationTokens
      totalTurns += summary.turnCount

      for (const record of summary.records) {
        const existing = byModel[record.model] ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUSD: 0,
        }
        existing.inputTokens += record.inputTokens
        existing.outputTokens += record.outputTokens
        existing.cacheReadTokens += record.cacheReadTokens
        existing.cacheCreationTokens += record.cacheCreationTokens
        existing.costUSD += record.costUSD
        byModel[record.model] = existing
      }
    }

    // Cache hit rate = cache_read / (cache_read + cache_creation + uncached_input)
    const totalCacheTokens = totalCacheReadTokens + totalCacheCreationTokens
    const cacheHitRate = totalCacheTokens > 0
      ? totalCacheReadTokens / totalCacheTokens
      : 0

    return {
      agents,
      byModel,
      totalCostUSD,
      cacheHitRate,
      totalTurns,
    }
  }

  /**
   * Check if the budget limit has been exceeded.
   */
  function isBudgetExceeded(): boolean {
    return getReport().totalCostUSD >= config.budgetLimitUSD
  }

  /**
   * Reset all tracking data.
   */
  function reset(): void {
    agentRecords.clear()
    warningFired = false
    limitFired = false
  }

  /**
   * Export report as JSON string.
   */
  function toJSON(): string {
    return JSON.stringify(getReport(), null, 2)
  }

  return {
    recordUsage,
    calculateCost,
    getAgentSummary,
    getReport,
    isBudgetExceeded,
    reset,
    toJSON,
    config,
  }
}

export type TokenTracker = ReturnType<typeof createTokenTracker>
