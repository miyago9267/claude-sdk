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
})
