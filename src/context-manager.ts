/**
 * Context Manager — SDK 層的 context 生命週期管理。
 *
 * 提供四個核心能力：
 * 1. Context 大小追蹤 + watermark 觸發
 * 2. 三級壓縮策略：handoff / compact / restart
 * 3. Cache keepalive（防止 API cache TTL 過期）
 * 4. Rapid-refill breaker（對應 cli.js H77=3，避免短時間反覆觸發 watermark）
 *
 * 與 cli.js 內建 auto-compact 的差異：
 * - cli.js auto-compact 用 9 段式詳細摘要（5-10K tokens）
 * - 這裡的 handoff 用自訂摘要 prompt（目標 2K tokens）
 * - 雙重保險：可同時設 subprocess env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 *
 * Cache TTL 雙模式（對應 cli.js 的 IIY() 判斷）：
 * - 非 bedrock 路徑：cli 對 prompt cache 加 ttl: "1h" → 預設 1hr TTL + 15min margin
 * - bedrock 路徑：沒有 1h opt-in，fallback 5min default → 預設 5min TTL + 60s margin
 * 觸發判斷依 process.env.CLAUDE_CODE_USE_BEDROCK。
 */

import {
  query,
  type SDKResultMessage,
  type ModelUsage,
} from '@anthropic-ai/claude-agent-sdk'

import type { V2Session } from './shared/query-session.ts'

// --- Types ---

export interface ContextManagerConfig {
  /** 觸發壓縮的 context token 門檻。Default: 150_000 */
  watermarkTokens?: number
  /** 模型 context window（tokens）。提供時觸發動態 watermark 計算。 */
  modelContextWindow?: number
  /** 動態 watermark 比例。Default: 0.75 */
  watermarkRatio?: number
  /** 動態 watermark 額外扣除的 buffer (對應 cli J77+kg8=13_500)。Default: 13_500 */
  watermarkBuffer?: number
  /** 對應 cli env CLAUDE_CODE_AUTO_COMPACT_WINDOW（range 1e5-1e6）。 */
  autoCompactWindow?: number
  /**
   * 壓縮策略。Default: 'handoff'
   * - handoff: 自訂摘要 → 開新 session（激進，完全可控）
   * - compact: cli.js 內建 /compact（保守，9 段式）
   * - restart: 開新 session，不保留歷史（最暴力）
   */
  strategy?: 'handoff' | 'compact' | 'restart'
  /** handoff 摘要目標 token 數。Default: 2000 */
  handoffTargetTokens?: number
  /** 自訂 handoff 摘要 prompt（覆寫內建 prompt） */
  handoffPrompt?: string
  /** rapid-refill 視窗 ms。Default: 60_000 (1min) */
  rapidRefillWindowMs?: number
  /** 視窗內連續幾次 compaction 視為 rapid-refill。Default: 3 */
  rapidRefillThreshold?: number
}

export interface CacheKeepaliveConfig {
  /** 是否啟用。Default: true */
  enabled?: boolean
  /**
   * API cache TTL（ms）。
   * Default: 環境決定 — 非 bedrock 為 3_600_000 (1hr)，bedrock 為 300_000 (5min)。
   * 對應 cli.js IIY() 對 ttl: "1h" 的 opt-in 判斷。
   */
  cacheTTLMs?: number
  /**
   * 提前量（ms）。
   * Default: 環境決定 — 1hr TTL 為 900_000 (15min)，5min TTL 為 60_000 (60s)。
   */
  marginMs?: number
}

export interface ContextState {
  /** 最近一次估算的 context 大小（tokens） */
  contextTokensEstimate: number
  /** 最近一次 API call 的時間戳 */
  lastApiCallAt: number
  /** 總共壓縮次數 */
  totalCompactions: number
  /** 最近 N 次 compaction 的時間戳（最舊在前），cap 在 5 筆 */
  recentCompactionTimestamps: number[]
  /** rapid-refill breaker 已跳閘的次數 */
  rapidRefillBreakerTrips: number
}

export interface ModelUsageDeltaResult {
  /** 本次相對於上一筆 cumulative usage 的增量 */
  deltaUsage: Record<string, ModelUsage>
  /** 是否偵測到 session / context 已重置 */
  resetDetected: boolean
}

export interface ContextManagerCallbacks {
  /** 取得當前 V2 session（如果有） */
  getSession: () => V2Session | null
  /** 取得當前 session ID（V1 resume 用） */
  getSessionId: () => string | null
  /** 重建 session 的 factory（handoff 後調用） */
  restartSession: (summaryContext?: string) => Promise<void>
  /** log 輸出 */
  log: (msg: string) => void
  /** model 名稱（handoff V1 query 用） */
  model: string
  /** 工作目錄 */
  cwd: string
}

function cloneModelUsageSnapshot(modelUsage: Record<string, ModelUsage>): Record<string, ModelUsage> {
  return Object.fromEntries(
    Object.entries(modelUsage).map(([model, usage]) => [model, { ...usage }]),
  )
}

function sumModelUsageTokens(modelUsage: Record<string, ModelUsage>): number {
  let total = 0
  for (const usage of Object.values(modelUsage)) {
    total += (usage.inputTokens ?? 0)
      + (usage.outputTokens ?? 0)
      + (usage.cacheReadInputTokens ?? 0)
      + (usage.cacheCreationInputTokens ?? 0)
  }
  return total
}

export function diffCumulativeModelUsage(
  currentUsage: Record<string, ModelUsage>,
  previousUsage: Record<string, ModelUsage> = {},
): ModelUsageDeltaResult {
  const resetDetected = sumModelUsageTokens(currentUsage) < sumModelUsageTokens(previousUsage)
  const deltaUsage: Record<string, ModelUsage> = {}

  for (const [model, usage] of Object.entries(currentUsage)) {
    const previous = previousUsage[model]
    if (resetDetected || !previous) {
      deltaUsage[model] = { ...usage }
      continue
    }

    deltaUsage[model] = {
      inputTokens: Math.max(0, (usage.inputTokens ?? 0) - (previous.inputTokens ?? 0)),
      outputTokens: Math.max(0, (usage.outputTokens ?? 0) - (previous.outputTokens ?? 0)),
      cacheReadInputTokens: Math.max(0, (usage.cacheReadInputTokens ?? 0) - (previous.cacheReadInputTokens ?? 0)),
      cacheCreationInputTokens: Math.max(0, (usage.cacheCreationInputTokens ?? 0) - (previous.cacheCreationInputTokens ?? 0)),
      webSearchRequests: Math.max(0, (usage.webSearchRequests ?? 0) - (previous.webSearchRequests ?? 0)),
      costUSD: Math.max(0, (usage.costUSD ?? 0) - (previous.costUSD ?? 0)),
      contextWindow: usage.contextWindow ?? previous.contextWindow,
      maxOutputTokens: usage.maxOutputTokens ?? previous.maxOutputTokens,
    }
  }

  return { deltaUsage, resetDetected }
}

// --- Default Handoff Prompt ---

function buildDefaultHandoffPrompt(targetTokens: number): string {
  return [
    '[SYSTEM] Context compression required. Produce a summary for session handoff.',
    '',
    `Target: ${targetTokens} tokens MAX. Be ruthless about brevity.`,
    '',
    'Include ONLY:',
    '1. Current task: what you are working on RIGHT NOW (1-2 sentences)',
    '2. Key decisions: architectural choices already made (bullet list, no code)',
    '3. Blockers: any unresolved issues or errors (brief)',
    '4. Pending: explicit requests from user not yet completed',
    '5. Working files: file paths being modified (paths only, no content)',
    '',
    'DO NOT include:',
    '- Code snippets or file contents',
    '- Tool call history or outputs',
    '- Conversation history or user messages',
    '- Error stack traces',
    '- Anything that can be re-derived by reading files',
    '',
    'Format: plain text, no XML tags, no markdown headers.',
    'Reply with ONLY the summary. No preamble.',
  ].join('\n')
}

// --- Bedrock-aware defaults ---

const RECENT_COMPACTION_TS_CAP = 5

function isBedrockEnv(): boolean {
  const v = process.env.CLAUDE_CODE_USE_BEDROCK
  if (!v) return false
  const lower = v.toLowerCase()
  return lower === '1' || lower === 'true'
}

/** 依 CLAUDE_CODE_USE_BEDROCK 決定預設 cache TTL（ms）。 */
export function detectDefaultCacheTTLMs(): number {
  return isBedrockEnv() ? 300_000 : 3_600_000
}

/** 依 TTL 決定預設 margin（ms）。 */
export function detectDefaultMarginMs(ttlMs: number): number {
  if (ttlMs >= 3_600_000) return 900_000
  if (ttlMs <= 300_000) return 60_000
  return Math.min(900_000, Math.max(60_000, Math.floor(ttlMs / 4)))
}

// --- Default subprocess env ---

/** 推薦的 subprocess 環境變數（激進 auto-compact） */
export const RECOMMENDED_SUBPROCESS_ENV = {
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '5',
} as const

/** 動態 watermark 預設比例（佔 modelContextWindow 的比例）。 */
export const DEFAULT_WATERMARK_RATIO = 0.75

/** 動態 watermark 預設 buffer（對應 cli J77+kg8=13_500 tokens）。 */
export const DEFAULT_WATERMARK_BUFFER = 13_500

/** 由 contextWindow / ratio / buffer 計算 watermark，clamp 在 >= 10_000。 */
export function computeDynamicWatermark(
  contextWindow: number,
  ratio: number,
  buffer: number,
): number {
  return Math.max(10_000, Math.floor(contextWindow * ratio) - buffer)
}

const AUTO_COMPACT_WINDOW_MIN = 100_000
const AUTO_COMPACT_WINDOW_MAX = 1_000_000

// --- Context Manager ---

export class ContextManager {
  private config: Required<Omit<ContextManagerConfig, 'modelContextWindow' | 'autoCompactWindow'>> & {
    modelContextWindow?: number
    autoCompactWindow?: number
  }
  private keepaliveConfig: Required<CacheKeepaliveConfig>
  private callbacks: ContextManagerCallbacks
  private state: ContextState
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null
  private lastModelUsageSnapshot: Record<string, ModelUsage> = {}

  constructor(
    config: ContextManagerConfig,
    keepalive: CacheKeepaliveConfig,
    callbacks: ContextManagerCallbacks,
  ) {
    if (config.autoCompactWindow !== undefined) {
      const v = config.autoCompactWindow
      if (!Number.isInteger(v) || v < AUTO_COMPACT_WINDOW_MIN || v > AUTO_COMPACT_WINDOW_MAX) {
        throw new Error('autoCompactWindow must be integer in [100000, 1000000]')
      }
    }

    const ratio = config.watermarkRatio ?? DEFAULT_WATERMARK_RATIO
    const buffer = config.watermarkBuffer ?? DEFAULT_WATERMARK_BUFFER
    const resolvedWatermark = config.watermarkTokens !== undefined
      ? config.watermarkTokens
      : config.modelContextWindow !== undefined
        ? computeDynamicWatermark(config.modelContextWindow, ratio, buffer)
        : 150_000

    this.config = {
      watermarkTokens: resolvedWatermark,
      modelContextWindow: config.modelContextWindow,
      watermarkRatio: ratio,
      watermarkBuffer: buffer,
      autoCompactWindow: config.autoCompactWindow,
      strategy: config.strategy ?? 'handoff',
      handoffTargetTokens: config.handoffTargetTokens ?? 2000,
      handoffPrompt: config.handoffPrompt ?? '',
      rapidRefillWindowMs: config.rapidRefillWindowMs ?? 60_000,
      rapidRefillThreshold: config.rapidRefillThreshold ?? 3,
    }
    const cacheTTLMs = keepalive.cacheTTLMs ?? detectDefaultCacheTTLMs()
    this.keepaliveConfig = {
      enabled: keepalive.enabled ?? true,
      cacheTTLMs,
      marginMs: keepalive.marginMs ?? detectDefaultMarginMs(cacheTTLMs),
    }
    this.callbacks = callbacks
    this.state = {
      contextTokensEstimate: 0,
      lastApiCallAt: 0,
      totalCompactions: 0,
      recentCompactionTimestamps: [],
      rapidRefillBreakerTrips: 0,
    }
  }

  /** 取得對應 subprocess 應注入的環境變數（含可選的 auto-compact window）。 */
  getSubprocessEnv(): Record<string, string> {
    const env: Record<string, string> = { ...RECOMMENDED_SUBPROCESS_ENV }
    if (this.config.autoCompactWindow !== undefined) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(this.config.autoCompactWindow)
    }
    return env
  }

  /** 取得當前 state（唯讀） */
  getState(): Readonly<ContextState> {
    return {
      ...this.state,
      recentCompactionTimestamps: [...this.state.recentCompactionTimestamps],
    }
  }

  /** 從 SDK result message 更新 context 估算 */
  updateFromResult(resultMsg: SDKResultMessage | undefined): void {
    if (!resultMsg) return
    this.state.lastApiCallAt = Date.now()

    if ('modelUsage' in resultMsg && resultMsg.modelUsage) {
      const { deltaUsage, resetDetected } = diffCumulativeModelUsage(
        resultMsg.modelUsage,
        this.lastModelUsageSnapshot,
      )
      const deltaTokens = sumModelUsageTokens(deltaUsage)
      this.state.contextTokensEstimate = resetDetected
        ? deltaTokens
        : this.state.contextTokensEstimate + deltaTokens
      this.lastModelUsageSnapshot = cloneModelUsageSnapshot(resultMsg.modelUsage)
    }
  }

  /** 每次 interaction 後呼叫：檢查是否需要壓縮 */
  async checkWatermark(): Promise<boolean> {
    const { watermarkTokens, strategy } = this.config
    if (watermarkTokens <= 0) return false
    if (this.state.contextTokensEstimate < watermarkTokens) return false

    const effective = this.applyRapidRefillBreaker(strategy)

    this.callbacks.log(
      `Context watermark hit: ${this.state.contextTokensEstimate} tokens >= ${watermarkTokens}. Strategy: ${effective}`,
    )

    if (effective === 'handoff') {
      await this.doHandoff()
    } else if (effective === 'compact') {
      await this.doBuiltinCompact()
    } else {
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
      this.lastModelUsageSnapshot = {}
    }

    this.state.totalCompactions++
    return true
  }

  /**
   * 對應 cli.js H77=3 breaker：視窗內反覆觸發壓縮就降級策略。
   * compact -> handoff -> restart；restart 已是最低不再降級。
   */
  private applyRapidRefillBreaker(
    original: 'handoff' | 'compact' | 'restart',
  ): 'handoff' | 'compact' | 'restart' {
    const { rapidRefillWindowMs, rapidRefillThreshold } = this.config
    const now = Date.now()
    const cutoff = now - rapidRefillWindowMs
    const recent = this.state.recentCompactionTimestamps.filter(t => t >= cutoff)
    recent.push(now)
    if (recent.length > RECENT_COMPACTION_TS_CAP) recent.splice(0, recent.length - RECENT_COMPACTION_TS_CAP)
    this.state.recentCompactionTimestamps = recent

    if (recent.length < rapidRefillThreshold) return original

    this.state.rapidRefillBreakerTrips++
    const downgraded = original === 'compact'
      ? 'handoff'
      : original === 'handoff'
        ? 'restart'
        : 'restart'
    this.callbacks.log(
      `rapid-refill breaker tripped: ${recent.length} compactions in ${rapidRefillWindowMs}ms, downgrading ${original} → ${downgraded}`,
    )
    this.state.recentCompactionTimestamps = []
    return downgraded
  }

  // --- Handoff ---

  private async doHandoff(): Promise<void> {
    const { handoffTargetTokens, handoffPrompt } = this.config
    const prompt = handoffPrompt || buildDefaultHandoffPrompt(handoffTargetTokens)
    let summary = ''

    try {
      const session = this.callbacks.getSession()
      if (session) {
        summary = await this.extractSummaryV2(session, prompt)
      } else {
        summary = await this.extractSummaryV1(prompt)
      }
    } catch (err) {
      this.callbacks.log(`Handoff summary failed, falling back to restart: ${err instanceof Error ? err.message : err}`)
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
      this.lastModelUsageSnapshot = {}
      return
    }

    // 清理 summary
    summary = summary
      .replace(/<analysis>[\s\S]*?<\/analysis>/g, '')
      .replace(/<summary>([\s\S]*?)<\/summary>/, '$1')
      .trim()

    if (!summary || summary.length < 50) {
      this.callbacks.log(`Handoff summary too short (${summary.length} chars), falling back to restart`)
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
      this.lastModelUsageSnapshot = {}
      return
    }

    const prevContext = this.state.contextTokensEstimate
    await this.callbacks.restartSession(summary)
    this.state.contextTokensEstimate = 0
    this.lastModelUsageSnapshot = {}

    this.callbacks.log(`Handoff complete: ${prevContext} → ~${Math.round(summary.length / 4)} tokens`)
  }

  private async extractSummaryV2(session: V2Session, prompt: string): Promise<string> {
    let text = ''
    await session.send(prompt)
    for await (const msg of session.stream()) {
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') text += b.text
          }
        }
      }
      if (msg.type === 'result') break
    }
    return text
  }

  private async extractSummaryV1(prompt: string): Promise<string> {
    let text = ''
    const sessionId = this.callbacks.getSessionId()
    const q = query({
      prompt,
      options: {
        model: this.callbacks.model,
        maxTurns: 1,
        cwd: this.callbacks.cwd,
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        resume: sessionId ?? undefined,
        disallowedTools: ['Write', 'Edit', 'Bash', 'Agent', 'Read', 'Glob', 'Grep'],
      },
    })
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        const content = (msg as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string') text += b.text
          }
        }
      }
    }
    return text
  }

  // --- Built-in Compact ---

  private async doBuiltinCompact(): Promise<void> {
    const session = this.callbacks.getSession()
    if (!session) {
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
      this.lastModelUsageSnapshot = {}
      return
    }

    try {
      await session.send('/compact')
      for await (const msg of session.stream()) {
        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage
          const prevContext = this.state.contextTokensEstimate

          // After compact the context is compressed, so the old estimate
          // is stale. Reset to 0 and take the compact result's cumulative
          // modelUsage as the new snapshot baseline. We intentionally do
          // NOT accumulate the result's usage into the estimate -- the
          // compressed context is much smaller than the cumulative total
          // would suggest.
          this.state.contextTokensEstimate = 0
          if ('modelUsage' in resultMsg && resultMsg.modelUsage) {
            this.lastModelUsageSnapshot = cloneModelUsageSnapshot(resultMsg.modelUsage)
          } else {
            this.lastModelUsageSnapshot = {}
          }

          this.callbacks.log(`Post-compact: ${this.state.contextTokensEstimate} tokens (was ${prevContext})`)
          break
        }
      }
    } catch (err) {
      this.callbacks.log(`Compact failed, falling back to restart: ${err instanceof Error ? err.message : err}`)
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
      this.lastModelUsageSnapshot = {}
    }
  }

  // --- Cache Keepalive ---

  /** 啟動 cache keepalive timer */
  startKeepalive(): void {
    if (!this.keepaliveConfig.enabled) return
    const session = this.callbacks.getSession()
    if (!session) return

    const interval = this.keepaliveConfig.cacheTTLMs - this.keepaliveConfig.marginMs
    if (interval <= 0) return

    this.callbacks.log(`Cache keepalive started (every ${Math.round(interval / 60_000)}min)`)
    this.scheduleKeepalive(interval)
  }

  /** 停止 cache keepalive */
  stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearTimeout(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private scheduleKeepalive(intervalMs: number): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer)

    this.keepaliveTimer = setTimeout(async () => {
      const session = this.callbacks.getSession()
      if (!session) return

      const msSinceLastCall = Date.now() - this.state.lastApiCallAt
      const needed = this.keepaliveConfig.cacheTTLMs - this.keepaliveConfig.marginMs

      // 如果最近有互動，跳過
      if (msSinceLastCall < needed) {
        this.scheduleKeepalive(needed - msSinceLastCall)
        return
      }

      try {
        this.callbacks.log('Cache keepalive ping')
        await session.send('Reply with only the word "ok". No explanation.')
        for await (const msg of session.stream()) {
          if (msg.type === 'result') {
            this.state.lastApiCallAt = Date.now()
            this.updateFromResult(msg as SDKResultMessage)
            break
          }
        }
        this.callbacks.log(`Cache keepalive done (context ~${this.state.contextTokensEstimate} tokens)`)

        // Keepalive 也可能讓 context 超過 watermark，必須檢查
        await this.checkWatermark()
      } catch (err) {
        this.callbacks.log(`Cache keepalive failed: ${err instanceof Error ? err.message : err}`)
      }

      if (session) this.scheduleKeepalive(intervalMs)
    }, intervalMs)
  }
}
