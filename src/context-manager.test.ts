import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  ContextManager,
  RECOMMENDED_SUBPROCESS_ENV,
  computeDynamicWatermark,
  DEFAULT_WATERMARK_RATIO,
  DEFAULT_WATERMARK_BUFFER,
  detectDefaultCacheTTLMs,
  detectDefaultMarginMs,
  diffCumulativeModelUsage,
  type ContextManagerCallbacks,
} from './context-manager.ts'
import type { SDKResultMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk'

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

describe('Patch A — Bedrock-aware cache TTL default', () => {
  const originalEnv = process.env.CLAUDE_CODE_USE_BEDROCK

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK
    else process.env.CLAUDE_CODE_USE_BEDROCK = originalEnv
  })

  test('detectDefaultCacheTTLMs returns 1hr when CLAUDE_CODE_USE_BEDROCK is unset', () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    expect(detectDefaultCacheTTLMs()).toBe(3_600_000)
  })

  test('detectDefaultCacheTTLMs returns 5min when CLAUDE_CODE_USE_BEDROCK="1"', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    expect(detectDefaultCacheTTLMs()).toBe(300_000)
  })

  test('detectDefaultCacheTTLMs returns 5min when CLAUDE_CODE_USE_BEDROCK="true"', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = 'true'
    expect(detectDefaultCacheTTLMs()).toBe(300_000)
  })

  test('detectDefaultCacheTTLMs returns 1hr when CLAUDE_CODE_USE_BEDROCK="0"', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '0'
    expect(detectDefaultCacheTTLMs()).toBe(3_600_000)
  })

  test('detectDefaultMarginMs returns 15min for 1hr TTL', () => {
    expect(detectDefaultMarginMs(3_600_000)).toBe(900_000)
  })

  test('detectDefaultMarginMs returns 60s for 5min TTL', () => {
    expect(detectDefaultMarginMs(300_000)).toBe(60_000)
  })

  test('ContextManager picks short TTL+margin when bedrock env is set', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      {},
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { keepaliveConfig: { cacheTTLMs: number; marginMs: number } }).keepaliveConfig
    expect(cfg.cacheTTLMs).toBe(300_000)
    expect(cfg.marginMs).toBe(60_000)
  })

  test('ContextManager picks 1hr TTL+15min margin when bedrock env is unset', () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      {},
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { keepaliveConfig: { cacheTTLMs: number; marginMs: number } }).keepaliveConfig
    expect(cfg.cacheTTLMs).toBe(3_600_000)
    expect(cfg.marginMs).toBe(900_000)
  })

  test('explicit cacheTTLMs overrides env detection', () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { cacheTTLMs: 1_800_000 },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { keepaliveConfig: { cacheTTLMs: number; marginMs: number } }).keepaliveConfig
    expect(cfg.cacheTTLMs).toBe(1_800_000)
  })

  test('explicit marginMs overrides default', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { marginMs: 12_345 },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { keepaliveConfig: { marginMs: number } }).keepaliveConfig
    expect(cfg.marginMs).toBe(12_345)
  })
})

describe('Patch B — Rapid-refill breaker', () => {
  type BreakerState = {
    recentCompactionTimestamps: number[]
    rapidRefillBreakerTrips: number
  }

  function makeRecordingCallbacks(restartCalls: Array<string | undefined>): ContextManagerCallbacks {
    return {
      getSession: () => null,
      getSessionId: () => null,
      restartSession: async (summary) => {
        restartCalls.push(summary)
      },
      log: () => {},
      model: 'claude-opus-4-6',
      cwd: '/tmp',
    }
  }

  test('getState exposes breaker fields with sane defaults', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const state = manager.getState() as ContextManager['getState'] extends () => infer R ? R : never
    const s = state as unknown as BreakerState & { totalCompactions: number }
    expect(s.recentCompactionTimestamps).toEqual([])
    expect(s.rapidRefillBreakerTrips).toBe(0)
  })

  test('three compactions within window trip breaker and downgrade compact -> handoff', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      {
        watermarkTokens: 1_000,
        strategy: 'compact',
        rapidRefillWindowMs: 60_000,
        rapidRefillThreshold: 3,
      },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    // Stub the private strategy executors so we observe which one is invoked.
    const calls: string[] = []
    ;(manager as unknown as { doBuiltinCompact: () => Promise<void> }).doBuiltinCompact = async () => {
      calls.push('compact')
    }
    ;(manager as unknown as { doHandoff: () => Promise<void> }).doHandoff = async () => {
      calls.push('handoff')
    }

    for (let i = 0; i < 3; i++) {
      ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
      await manager.checkWatermark()
    }

    const s = manager.getState() as unknown as BreakerState & { totalCompactions: number }
    expect(s.rapidRefillBreakerTrips).toBe(1)
    expect(s.totalCompactions).toBe(3)
    expect(calls).toEqual(['compact', 'compact', 'handoff'])
  })

  test('breaker downgrades handoff -> restart', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      {
        watermarkTokens: 1_000,
        strategy: 'handoff',
        rapidRefillWindowMs: 60_000,
        rapidRefillThreshold: 3,
      },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    const calls: string[] = []
    ;(manager as unknown as { doHandoff: () => Promise<void> }).doHandoff = async () => {
      calls.push('handoff')
    }

    for (let i = 0; i < 3; i++) {
      ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
      await manager.checkWatermark()
    }

    const s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(1)
    // First two go through stubbed doHandoff; third is downgraded to restart -> restartSession() called.
    expect(calls).toEqual(['handoff', 'handoff'])
    expect(restarts.length).toBe(1)
    expect(restarts[0]).toBeUndefined()
  })

  test('restart strategy is not downgraded further', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      {
        watermarkTokens: 1_000,
        strategy: 'restart',
        rapidRefillWindowMs: 60_000,
        rapidRefillThreshold: 3,
      },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    for (let i = 0; i < 3; i++) {
      ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
      await manager.checkWatermark()
    }

    const s = manager.getState() as unknown as BreakerState & { totalCompactions: number }
    // Breaker still trips (counter accounting), but strategy unchanged.
    expect(s.rapidRefillBreakerTrips).toBe(1)
    expect(s.totalCompactions).toBe(3)
  })

  test('compactions outside the window do not trip breaker', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      {
        watermarkTokens: 1_000,
        strategy: 'restart',
        rapidRefillWindowMs: 1_000,
        rapidRefillThreshold: 3,
      },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    const realNow = Date.now
    let fakeNow = 1_000_000
    Date.now = () => fakeNow

    try {
      for (let i = 0; i < 3; i++) {
        ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
        await manager.checkWatermark()
        fakeNow += 5_000 // 5s apart, window is 1s -> never 3 in window
      }
    } finally {
      Date.now = realNow
    }

    const s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(0)
  })

  test('breaker resets window after tripping (no immediate re-trip on next call)', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      {
        watermarkTokens: 1_000,
        strategy: 'restart',
        rapidRefillWindowMs: 60_000,
        rapidRefillThreshold: 3,
      },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    for (let i = 0; i < 3; i++) {
      ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
      await manager.checkWatermark()
    }
    let s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(1)
    expect(s.recentCompactionTimestamps.length).toBe(0)

    // One more compaction: should NOT re-trip immediately (window was reset).
    ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
    await manager.checkWatermark()
    s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(1)
  })

  test('default threshold is 3 and default window is 60_000ms', async () => {
    const restarts: Array<string | undefined> = []
    const manager = new ContextManager(
      { watermarkTokens: 1_000, strategy: 'restart' },
      { enabled: false },
      makeRecordingCallbacks(restarts),
    )

    for (let i = 0; i < 2; i++) {
      ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
      await manager.checkWatermark()
    }
    let s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(0)

    ;(manager as unknown as { state: { contextTokensEstimate: number } }).state.contextTokensEstimate = 50_000
    await manager.checkWatermark()
    s = manager.getState() as unknown as BreakerState
    expect(s.rapidRefillBreakerTrips).toBe(1)
  })
})

describe('Patch C1 — dynamic watermark from modelContextWindow', () => {
  test('explicit watermarkTokens wins even when modelContextWindow is set', () => {
    const manager = new ContextManager(
      { watermarkTokens: 200_000, modelContextWindow: 1_000_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { config: { watermarkTokens: number } }).config
    expect(cfg.watermarkTokens).toBe(200_000)
  })

  test('modelContextWindow alone computes watermark via ratio - buffer', () => {
    const manager = new ContextManager(
      { modelContextWindow: 200_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { config: { watermarkTokens: number } }).config
    expect(cfg.watermarkTokens).toBe(Math.floor(200_000 * 0.75) - 13_500)
  })

  test('tiny modelContextWindow clamps watermark to floor 10_000', () => {
    // 20_000 * 0.75 - 13_500 = 1_500 → clamp to 10_000
    const manager = new ContextManager(
      { modelContextWindow: 20_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { config: { watermarkTokens: number } }).config
    expect(cfg.watermarkTokens).toBe(10_000)
  })

  test('neither field set falls back to 150_000', () => {
    const manager = new ContextManager(
      {},
      { enabled: false },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { config: { watermarkTokens: number } }).config
    expect(cfg.watermarkTokens).toBe(150_000)
  })

  test('computeDynamicWatermark formula', () => {
    expect(computeDynamicWatermark(1_000_000, 0.75, 13_500)).toBe(736_500)
    expect(computeDynamicWatermark(200_000, 0.75, 13_500)).toBe(136_500)
  })

  test('computeDynamicWatermark clamps result to >= 10_000', () => {
    expect(computeDynamicWatermark(20_000, 0.75, 13_500)).toBe(10_000)
    expect(computeDynamicWatermark(0, 0.75, 13_500)).toBe(10_000)
  })

  test('default constants exported with expected values', () => {
    expect(DEFAULT_WATERMARK_RATIO).toBe(0.75)
    expect(DEFAULT_WATERMARK_BUFFER).toBe(13_500)
  })

  test('custom ratio and buffer applied via config', () => {
    const manager = new ContextManager(
      { modelContextWindow: 1_000_000, watermarkRatio: 0.5, watermarkBuffer: 0 },
      { enabled: false },
      makeCallbacks(),
    )
    const cfg = (manager as unknown as { config: { watermarkTokens: number } }).config
    expect(cfg.watermarkTokens).toBe(500_000)
  })
})

describe('Patch C2 — autoCompactWindow subprocess env', () => {
  test('getSubprocessEnv omits AUTO_COMPACT_WINDOW when not configured', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const env = manager.getSubprocessEnv()
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    // base env still present
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe(RECOMMENDED_SUBPROCESS_ENV.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE)
  })

  test('getSubprocessEnv includes AUTO_COMPACT_WINDOW as string when configured', () => {
    const manager = new ContextManager(
      { watermarkTokens: 1_000, autoCompactWindow: 200_000 },
      { enabled: false },
      makeCallbacks(),
    )
    const env = manager.getSubprocessEnv()
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000')
  })

  test('constructor throws when autoCompactWindow below 100_000', () => {
    expect(() => new ContextManager(
      { autoCompactWindow: 99_999 },
      { enabled: false },
      makeCallbacks(),
    )).toThrow('autoCompactWindow must be integer in [100000, 1000000]')
  })

  test('constructor throws when autoCompactWindow above 1_000_000', () => {
    expect(() => new ContextManager(
      { autoCompactWindow: 1_000_001 },
      { enabled: false },
      makeCallbacks(),
    )).toThrow('autoCompactWindow must be integer in [100000, 1000000]')
  })

  test('constructor throws when autoCompactWindow is not an integer', () => {
    expect(() => new ContextManager(
      { autoCompactWindow: 200_000.5 },
      { enabled: false },
      makeCallbacks(),
    )).toThrow('autoCompactWindow must be integer in [100000, 1000000]')
  })

  test('boundary values 100_000 and 1_000_000 accepted', () => {
    expect(() => new ContextManager(
      { autoCompactWindow: 100_000 },
      { enabled: false },
      makeCallbacks(),
    )).not.toThrow()
    expect(() => new ContextManager(
      { autoCompactWindow: 1_000_000 },
      { enabled: false },
      makeCallbacks(),
    )).not.toThrow()
  })
})
