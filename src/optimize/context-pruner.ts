/**
 * Context Pruner -- Sliding window + summarization for conversation history.
 *
 * Limitations:
 * - SDK does not expose conversation history directly during a live session.
 * - This module works on an external turn log that the caller maintains,
 *   or on subagent system prompts (which we CAN control via AgentDefinition.prompt).
 * - For live sessions, the SDK's built-in compaction (auto-compact) handles
 *   context overflow. We augment this by:
 *   1. Configuring maxTurns on the SDK Options
 *   2. Using SubagentStart hooks to inject summarized context
 *   3. Providing a utility to build pruned prompts for subagents
 */

import type {
  ConversationTurn,
  ContextPrunerConfig,
  PrunedContext,
} from './types.js'
import { DEFAULT_PRUNER_CONFIG } from './types.js'

/**
 * Estimate token count from text using a simple heuristic.
 * ~4 characters per token for English text, ~2 for CJK.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters (rough detection)
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u309f\u30a0-\u30ff]/g) ?? []).length
  const nonCjkLength = text.length - cjkCount
  return Math.ceil(nonCjkLength / 4 + cjkCount / 2)
}

/**
 * Create a context pruner instance with the given configuration.
 */
export function createContextPruner(userConfig?: Partial<ContextPrunerConfig>) {
  const config: ContextPrunerConfig = {
    ...DEFAULT_PRUNER_CONFIG,
    ...userConfig,
  }

  /**
   * Prune conversation turns using sliding window strategy.
   * Keeps the most recent `maxTurns` turns, drops older ones.
   * If total tokens exceed `maxTokens`, drops additional older turns.
   */
  function prune(turns: ConversationTurn[]): PrunedContext {
    if (turns.length === 0) {
      return { summary: '', turns: [], totalTokens: 0, droppedTurns: 0 }
    }

    // Step 1: Apply maxTurns sliding window
    let kept = turns.slice(-config.maxTurns)
    let dropped = turns.length - kept.length

    // Step 2: Apply maxTokens budget (drop from oldest)
    let totalTokens = kept.reduce((sum, t) => sum + t.tokenEstimate, 0)
    while (totalTokens > config.maxTokens && kept.length > 1) {
      const removed = kept.shift()
      if (removed) {
        totalTokens -= removed.tokenEstimate
        dropped++
      }
    }

    // Step 3: Build summary of dropped turns
    const droppedTurns = turns.slice(0, dropped)
    const summary = droppedTurns.length > 0
      ? buildDropSummary(droppedTurns)
      : ''

    return {
      summary,
      turns: kept,
      totalTokens,
      droppedTurns: dropped,
    }
  }

  /**
   * Build a concise summary description of dropped turns.
   * This is a local heuristic summary (not an LLM call).
   * For LLM-based summarization, use `buildSummarizedPrompt`.
   */
  function buildDropSummary(dropped: ConversationTurn[]): string {
    const totalDroppedTokens = dropped.reduce((s, t) => s + t.tokenEstimate, 0)
    const userTurns = dropped.filter(t => t.role === 'user').length
    const assistantTurns = dropped.filter(t => t.role === 'assistant').length
    return `[Context pruned: ${dropped.length} turns removed (${userTurns} user, ${assistantTurns} assistant, ~${totalDroppedTokens} tokens). Retained ${0} most recent turns.]`
  }

  /**
   * Determine if history should be summarized based on turn count.
   */
  function shouldSummarize(turnCount: number): boolean {
    return turnCount > config.summarizeAfter
  }

  /**
   * Build a system prompt prefix that includes summarized context
   * for a subagent. This replaces blindly forwarding full history.
   */
  function buildSubagentContext(
    parentSummary: string,
    taskDescription: string,
  ): string {
    const parts: string[] = []

    if (parentSummary) {
      parts.push(`## Previous Context Summary\n\n${parentSummary}`)
    }

    parts.push(`## Current Task\n\n${taskDescription}`)

    return parts.join('\n\n')
  }

  return {
    prune,
    shouldSummarize,
    buildSubagentContext,
    estimateTokens,
    config,
  }
}

export type ContextPruner = ReturnType<typeof createContextPruner>
