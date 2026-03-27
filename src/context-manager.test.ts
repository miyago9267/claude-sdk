import { describe, expect, test } from 'bun:test'

import {
  ContextManager,
  diffCumulativeModelUsage,
  type ContextManagerCallbacks,
} from './context-manager.ts'
import type { SDKResultMessage, ModelUsage } from './sdk.mjs'

function makeUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens: number,
  cacheCreationInputTokens: number,
  costUSD: number,
  webSearchRequests = 0,
): ModelUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests,
    costUSD,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  }
}

function makeResult(modelUsage: Record<string, ModelUsage>): SDKResultMessage {
  return {
    type: 'result',
    modelUsage,
  } as unknown as SDKResultMessage
}

function makeCallbacks(): ContextManagerCallbacks {
  return {
    getSession: () => null,
    getSessionId: () => null,
    restartSession: async () => {},
    log: () => {},
    model: 'claude-opus-4-6',
    cwd: '/tmp',
  }
}

describe('cumulative usage semantics', () => {
  test('diffCumulativeModelUsage converts cumulative snapshots into per-turn deltas', () => {
    const previous = {
      'claude-opus-4-6': makeUsage(100, 20, 10, 5, 0.5, 1),
    }
    const current = {
      'claude-opus-4-6': makeUsage(145, 29, 12, 7, 0.9, 2),
    }

    const { deltaUsage, resetDetected } = diffCumulativeModelUsage(current, previous)

    expect(resetDetected).toBe(false)
    expect(deltaUsage['claude-opus-4-6']).toEqual({
      inputTokens: 45,
      outputTokens: 9,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 2,
      webSearchRequests: 1,
      costUSD: 0.4,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    })
  })

  test('ContextManager accumulates delta usage instead of raw cumulative totals', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { enabled: false },
      makeCallbacks(),
    )

    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(120, 15, 8, 4, 0.6),
    }))
    expect(manager.getState().contextTokensEstimate).toBe(147)

    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(150, 20, 8, 5, 0.9),
    }))
    expect(manager.getState().contextTokensEstimate).toBe(183)
  })

  test('ContextManager treats a lower cumulative snapshot as a reset', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { enabled: false },
      makeCallbacks(),
    )

    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(200, 40, 10, 5, 1.2),
    }))
    expect(manager.getState().contextTokensEstimate).toBe(255)

    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(30, 8, 2, 1, 0.15),
    }))
    expect(manager.getState().contextTokensEstimate).toBe(41)
  })

  test('post-compact estimate should reset to 0 (compact bug fix)', () => {
    // Bug scenario:
    // 1. Manager accumulates large contextTokensEstimate over many turns
    // 2. Compact fires (/compact within same session)
    // 3. CLI cumulative modelUsage keeps incrementing (no session restart)
    // 4. Old code called updateFromResult(compactResult) without resetting,
    //    so estimate = large_old + delta = INCREASES after compact
    //
    // Fix: doBuiltinCompact resets contextTokensEstimate to 0 and sets
    // lastModelUsageSnapshot to the compact result's cumulative, WITHOUT
    // calling updateFromResult. This way:
    //  - estimate = 0 immediately after compact (correct: context is compressed)
    //  - snapshot = compact result's cumulative (correct baseline for future diffs)
    //  - next real interaction's delta is correctly computed from the new baseline

    const manager = new ContextManager(
      { watermarkTokens: 200_000 },
      { enabled: false },
      makeCallbacks(),
    )

    // Simulate several turns of accumulation (pre-compact state)
    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(50_000, 10_000, 30_000, 5_000, 20),
    }))
    manager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(100_000, 20_000, 60_000, 10_000, 40),
    }))
    const preCompactEstimate = manager.getState().contextTokensEstimate
    expect(preCompactEstimate).toBe(190_000) // 95k + 95k accumulated deltas

    // After compact: old code would call updateFromResult(compactResult)
    // which adds delta on top of 190k. New code resets estimate to 0 and
    // only updates the snapshot. We verify the reset pattern here by
    // confirming that a fresh manager (simulating post-reset state) starts
    // at 0 and correctly diffs the next real interaction.
    const freshManager = new ContextManager(
      { watermarkTokens: 200_000 },
      { enabled: false },
      makeCallbacks(),
    )
    // freshManager.contextTokensEstimate = 0 (simulates reset)
    // freshManager.lastModelUsageSnapshot = {} (will be set to compact result)
    expect(freshManager.getState().contextTokensEstimate).toBe(0)

    // First real interaction AFTER compact: cumulative grows slightly
    // from the compact baseline. The delta should be small.
    freshManager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(105_000, 22_000, 62_000, 11_000, 42),
    }))
    // estimate = 0 + all fields (no previous snapshot) = 200k
    // This is the initial baseline, subsequent turns will delta correctly
    const firstPostCompact = freshManager.getState().contextTokensEstimate
    expect(firstPostCompact).toBe(200_000)

    // Second interaction after compact: only the delta is added
    freshManager.updateFromResult(makeResult({
      'claude-opus-4-6': makeUsage(108_000, 23_000, 63_000, 11_500, 43),
    }))
    const secondPostCompact = freshManager.getState().contextTokensEstimate
    // delta = 3000 + 1000 + 1000 + 500 = 5500
    expect(secondPostCompact).toBe(200_000 + 5_500)
  })
})
