/**
 * Context Manager — SDK 層的 context 生命週期管理。
 *
 * 提供三個核心能力：
 * 1. Context 大小追蹤 + watermark 觸發
 * 2. 三級壓縮策略：handoff / compact / restart
 * 3. Cache keepalive（防止 API cache TTL 過期）
 *
 * 與 cli.js 內建 auto-compact 的差異：
 * - cli.js auto-compact 用 9 段式詳細摘要（5-10K tokens）
 * - 這裡的 handoff 用自訂摘要 prompt（目標 2K tokens）
 * - 雙重保險：可同時設 subprocess env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
 */

import {
  query,
  unstable_v2_createSession,
  type SDKSession,
  type SDKSessionOptions,
  type SDKResultMessage,
  type ModelUsage,
} from './sdk.mjs'

// --- Types ---

export interface ContextManagerConfig {
  /** 觸發壓縮的 context token 門檻。Default: 150_000 */
  watermarkTokens?: number
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
}

export interface CacheKeepaliveConfig {
  /** 是否啟用。Default: true */
  enabled?: boolean
  /** API cache TTL（ms）。Default: 3_600_000 (1hr) */
  cacheTTLMs?: number
  /** 提前量（ms）。Default: 900_000 (15min) */
  marginMs?: number
}

export interface ContextState {
  /** 最近一次估算的 context 大小（tokens） */
  contextTokensEstimate: number
  /** 最近一次 API call 的時間戳 */
  lastApiCallAt: number
  /** 總共壓縮次數 */
  totalCompactions: number
}

export interface ContextManagerCallbacks {
  /** 取得當前 V2 session（如果有） */
  getSession: () => SDKSession | null
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

// --- Default subprocess env ---

/** 推薦的 subprocess 環境變數（激進 auto-compact） */
export const RECOMMENDED_SUBPROCESS_ENV = {
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '5',
} as const

// --- Context Manager ---

export class ContextManager {
  private config: Required<ContextManagerConfig>
  private keepaliveConfig: Required<CacheKeepaliveConfig>
  private callbacks: ContextManagerCallbacks
  private state: ContextState
  private keepaliveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    config: ContextManagerConfig,
    keepalive: CacheKeepaliveConfig,
    callbacks: ContextManagerCallbacks,
  ) {
    this.config = {
      watermarkTokens: config.watermarkTokens ?? 150_000,
      strategy: config.strategy ?? 'handoff',
      handoffTargetTokens: config.handoffTargetTokens ?? 2000,
      handoffPrompt: config.handoffPrompt ?? '',
    }
    this.keepaliveConfig = {
      enabled: keepalive.enabled ?? true,
      cacheTTLMs: keepalive.cacheTTLMs ?? 3_600_000,
      marginMs: keepalive.marginMs ?? 900_000,
    }
    this.callbacks = callbacks
    this.state = {
      contextTokensEstimate: 0,
      lastApiCallAt: 0,
      totalCompactions: 0,
    }
  }

  /** 取得當前 state（唯讀） */
  getState(): Readonly<ContextState> {
    return { ...this.state }
  }

  /** 從 SDK result message 更新 context 估算 */
  updateFromResult(resultMsg: SDKResultMessage | undefined): void {
    if (!resultMsg) return
    this.state.lastApiCallAt = Date.now()

    if ('modelUsage' in resultMsg && resultMsg.modelUsage) {
      let totalInput = 0
      for (const usage of Object.values(resultMsg.modelUsage) as ModelUsage[]) {
        totalInput += (usage.inputTokens ?? 0)
          + (usage.cacheReadInputTokens ?? 0)
          + (usage.cacheCreationInputTokens ?? 0)
      }
      this.state.contextTokensEstimate = totalInput
    }
  }

  /** 每次 interaction 後呼叫：檢查是否需要壓縮 */
  async checkWatermark(): Promise<boolean> {
    const { watermarkTokens, strategy } = this.config
    if (watermarkTokens <= 0) return false
    if (this.state.contextTokensEstimate < watermarkTokens) return false

    this.callbacks.log(
      `Context watermark hit: ${this.state.contextTokensEstimate} tokens >= ${watermarkTokens}. Strategy: ${strategy}`,
    )

    if (strategy === 'handoff') {
      await this.doHandoff()
    } else if (strategy === 'compact') {
      await this.doBuiltinCompact()
    } else {
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
    }

    this.state.totalCompactions++
    return true
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
      return
    }

    const prevContext = this.state.contextTokensEstimate
    await this.callbacks.restartSession(summary)
    this.state.contextTokensEstimate = 0

    this.callbacks.log(`Handoff complete: ${prevContext} → ~${Math.round(summary.length / 4)} tokens`)
  }

  private async extractSummaryV2(session: SDKSession, prompt: string): Promise<string> {
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
      return
    }

    try {
      await session.send('/compact')
      for await (const msg of session.stream()) {
        if (msg.type === 'result') {
          const resultMsg = msg as SDKResultMessage
          if ('modelUsage' in resultMsg && resultMsg.modelUsage) {
            let postTokens = 0
            for (const usage of Object.values(resultMsg.modelUsage) as ModelUsage[]) {
              postTokens += (usage.inputTokens ?? 0)
                + (usage.cacheReadInputTokens ?? 0)
                + (usage.cacheCreationInputTokens ?? 0)
            }
            this.callbacks.log(`Post-compact: ${postTokens} tokens (was ${this.state.contextTokensEstimate})`)
            this.state.contextTokensEstimate = postTokens
          }
          break
        }
      }
    } catch (err) {
      this.callbacks.log(`Compact failed, falling back to restart: ${err instanceof Error ? err.message : err}`)
      await this.callbacks.restartSession()
      this.state.contextTokensEstimate = 0
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
