/**
 * Hono server exposing the Ollama-native HTTP API backed by Claude SDK V2
 * sessions. GitHub Copilot Chat and similar tools that target a local Ollama
 * install can point at this server unmodified.
 *
 * Phase 1 scope: /api/version, /api/tags, /api/show, non-streaming /api/chat.
 * Streaming + session pool + tool/thinking forwarding land in later phases.
 */

import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { stream, streamSSE } from 'hono/streaming'

import {
  type Options,
  type PermissionMode,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk'

import { createV2Session, type V2Session } from '../shared/query-session.ts'
import { RECOMMENDED_SUBPROCESS_ENV } from '../context-manager.ts'
import {
  extractAssistantBlocks,
  stripDataUrlPrefix,
  type HistoryMessage,
  type ImageAttachment,
} from '../shared/messages.ts'
import {
  StreamingChunkConverter,
  attachmentsFromHistory,
  buildNonStreamingResponse,
  buildPromptFromOpenAIMessages,
  openAIMessagesToHistory,
  resultErrorMessage,
  type OpenAIChatCompletionChunk,
  type OpenAIChatCompletionRequest,
  type OpenAIChatCompletionResponse,
  type OpenAIModelsResponse,
} from './openai-compat.ts'
import { SessionPool, hashHistoryPrefix } from './session-pool.ts'
import {
  buildDoneFrame,
  buildPromptFromOllamaMessages,
  buildShowResponse,
  buildTagsResponse,
  ollamaMessagesToHistory,
} from './transform.ts'
import type {
  OllamaChatRequest,
  OllamaShowRequest,
  OllamaVersionResponse,
} from './types.ts'
import type { BotRuntime } from '../runtime/bot-runtime.ts'
import type { RuntimeEvent } from '../runtime/events.ts'

export const DEFAULT_OLLAMA_PORT = 11434
export const FALLBACK_OLLAMA_PORT = 41434
// VS Code GitHub Copilot enforces a minimum Ollama version (>= 0.6.4 as of
// 2026-04-29) and rejects anything lower. The string must be a plain semver
// — pre-release suffixes like `-claude-bridge` get parsed and may also fail
// the floor check. Keep this comfortably ahead of the floor; bump if Copilot
// raises it. Bridge identity lives in the `/` root marker instead.
export const BRIDGE_VERSION = '0.10.0'

export const DEFAULT_EXPOSED_MODELS = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  // Advertised for completeness. Not granted on Pro/Max subscription — a call
  // returns the upstream "may not exist or you may not have access" message
  // verbatim (see resultErrorMessage), not a fake success.
  'claude-fable-5',
] as const

export interface OllamaServerConfig {
  defaultModel?: string
  cwd?: string
  systemPromptOverride?: string
  settingSources?: SettingSource[]
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  maxTurns?: number
  /**
   * Tool allowlist passed to the V2 session. Defaults to `[]` (no tools)
   * because the bridge is chat-only — see ADR-3. Override only if you know
   * what you're doing (the bridge cwd is the claude-sdk repo, not the IDE
   * workspace, so any tool the model uses won't touch user files).
   */
  allowedTools?: string[]
  exposedModels?: string[]
  extraSessionOptions?: Partial<Options>
  /** Route bridge turns through the bot runtime composition root. */
  runtime?: BotRuntime
  runtimeBotId?: string
  runtimeSessionKey?: (input: {
    model: string
    history: HistoryMessage[]
    clientId?: string
  }) => string
}

export function createOllamaServer(
  config: OllamaServerConfig = {},
  pool: SessionPool = new SessionPool(),
): Hono {
  const app = new Hono()
  app.use('*', cors())

  const exposedModels = config.exposedModels?.length
    ? config.exposedModels
    : [...DEFAULT_EXPOSED_MODELS]

  app.get('/', (c) =>
    c.text(`Ollama is running\n(@miyago/claude-sdk bridge ${BRIDGE_VERSION})\n`),
  )

  app.get('/api/version', (c) => {
    const body: OllamaVersionResponse = { version: BRIDGE_VERSION }
    return c.json(body)
  })

  app.get('/api/tags', (c) => c.json(buildTagsResponse(exposedModels)))

  // OpenAI-compat surface: Copilot's OllamaProvider chats over /v1/chat/completions
  // (SSE), not /api/chat. We host both — see ADR-1 in docs/specs/ollama-bridge/SPEC.md.
  app.get('/v1/models', (c) => {
    const body: OpenAIModelsResponse = {
      object: 'list',
      data: exposedModels.map((id) => ({
        id,
        object: 'model' as const,
        created: 0,
        owned_by: 'anthropic',
      })),
    }
    return c.json(body)
  })

  app.post('/api/show', async (c) => {
    let body: OllamaShowRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }
    if (!body.model) return c.json({ error: 'missing field: model' }, 400)
    return c.json(buildShowResponse(body.model))
  })

  app.post('/api/chat', async (c) => {
    let body: OllamaChatRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400)
    }

    const validation = validateChatRequest(body)
    if (validation) return c.json({ error: validation }, 400)

    const model = body.model || config.defaultModel || 'claude-sonnet-4-6'
    const { systemPrompt, prompt, attachments } = buildPromptFromOllamaMessages(body.messages)
    const effectiveSystem = config.systemPromptOverride ?? systemPrompt ?? undefined

    if (config.runtime) {
      if (!config.runtimeBotId) return c.json({ error: 'runtimeBotId is required when runtime is configured' }, 500)
      const history = ollamaMessagesToHistory(body.messages)
      const runtimeRequest = {
        botId: config.runtimeBotId,
        sessionKey: runtimeSessionKey(config, model, history),
        trigger: 'message' as const,
        idempotencyKey: runtimeRequestId('ollama', model, history),
        prompt,
        systemPrompt: effectiveSystem,
        attachments,
        model,
        ...(config.cwd ? { workspace: config.cwd } : {}),
      }
      if (body.stream) {
        return runtimeOllamaStream(c, config.runtime, runtimeRequest)
      }
      try {
        const result = await config.runtime.run(runtimeRequest)
        if (result.status !== 'completed') {
          return c.json({ error: result.error ?? 'bot run failed' }, 502)
        }
        return c.json(buildDoneFrame({
          model,
          blocks: { text: result.output ?? '', toolUses: [], stopReason: 'end_turn' },
          result: null,
        }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return c.json({ error: message }, 500)
      }
    }

    if (body.stream === true) {
      return c.json(
        { error: 'streaming is not implemented in Phase 1; pass "stream": false' },
        501,
      )
    }

    const session = createV2Session({
      model,
      cwd: config.cwd ?? process.cwd(),
      systemPrompt: effectiveSystem,
      settingSources: config.settingSources ?? [],
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions ?? true,
      // Agent loop allowed: SDK self-dispatches built-in tools (Read/Write/
      // Bash/Edit/Glob/Grep) against the bridge cwd. The model's tool_use
      // blocks are dropped at the transport layer (see fromAssistantMessage)
      // so Copilot only sees the model's narrative text, not OpenAI
      // tool_calls it can't execute. Bridge cwd === wherever you ran
      // the process that calls `serveOllamaBridge()` — point it at the project you want
      // edited.
      maxTurns: config.maxTurns ?? 10,
      ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
      includePartialMessages: false,
      env: {
        ...process.env,
        ...RECOMMENDED_SUBPROCESS_ENV,
        // Bridge sessions are short-lived and stateless (per-request); don't
        // need aggressive autocompact (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=5).
        // Setting it high prevents the "thrashing: 3 compacts in 3 turns"
        // failure when Copilot ships ~14K prompt + history each call.
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '95',
      },
      ...config.extraSessionOptions,
    })

    const startedAt = process.hrtime.bigint()
    const assistantMsgs: SDKAssistantMessage[] = []
    let result: SDKResultMessage | null = null

    try {
      await session.send(buildSendPayload(prompt, attachments))
      for await (const msg of session.stream()) {
        if (msg.type === 'assistant') assistantMsgs.push(msg as SDKAssistantMessage)
        if (msg.type === 'result') {
          result = msg as SDKResultMessage
          break
        }
      }
    } catch (err) {
      safeClose(session)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
    safeClose(session)

    const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
    const blocks = lastAssistant
      ? extractAssistantBlocks(lastAssistant)
      : { text: '', toolUses: [], stopReason: null }

    const totalNs = Number(process.hrtime.bigint() - startedAt)
    const frame = buildDoneFrame({
      model,
      blocks,
      result,
      durations: { totalDurationNs: totalNs },
    })
    return c.json(frame)
  })

  app.post('/v1/chat/completions', async (c) => {
    let body: OpenAIChatCompletionRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json(
        { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
        400,
      )
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        { error: { message: '`messages` must be a non-empty array', type: 'invalid_request_error' } },
        400,
      )
    }

    const requestId = `chatcmpl-${cryptoRandom()}`
    const model = body.model || config.defaultModel || 'claude-sonnet-4-6'
    const history = openAIMessagesToHistory(body.messages)
    const { systemPrompt, prompt: fullPrompt } = buildPromptFromOpenAIMessages(body.messages)
    const attachments = attachmentsFromHistory(history)
    const effectiveSystem = config.systemPromptOverride ?? systemPrompt ?? undefined

    if (config.runtime) {
      if (!config.runtimeBotId) return c.json({ error: { message: 'runtimeBotId is required when runtime is configured', type: 'server_error' } }, 500)
      const runtimeRequest = {
        botId: config.runtimeBotId,
        sessionKey: runtimeSessionKey(config, model, history, body.user),
        trigger: 'message' as const,
        idempotencyKey: runtimeRequestId('openai', model, history, body.user),
        prompt: fullPrompt,
        systemPrompt: effectiveSystem,
        attachments,
        model,
        ...(config.cwd ? { workspace: config.cwd } : {}),
      }
      if (body.stream) {
        return runtimeOpenAIStream(c, config.runtime, runtimeRequest, requestId, model)
      }
      try {
        const result = await config.runtime.run(runtimeRequest)
        if (result.status !== 'completed') {
          return c.json({ error: { message: result.error ?? 'bot run failed', type: 'upstream_error' } }, 502)
        }
        return c.json(buildRuntimeOpenAIResponse(requestId, model, result.output ?? ''))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return c.json({ error: { message, type: 'server_error' } }, 500)
      }
    }

    const acquired = acquireOrCreate({
      pool,
      config,
      model,
      effectiveSystem,
      history,
      fullPrompt,
    })
    debugLog(
      `[chat] id=${requestId} model=${model} history_len=${history.length} ` +
        `pool_hit=${acquired.reused} pool_size=${pool.size()}`,
    )

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        const converter = new StreamingChunkConverter(requestId, model)
        let result: SDKResultMessage | null = null
        let assistantText = ''
        let chunksEmitted = 0
        let firstChunkAt = 0
        let firstSdkMsgAt = 0
        let assistantTurnCount = 0
        const tStart = performance.now()
        await stream.writeSSE({ data: JSON.stringify(converter.buildRoleChunk()) })
        chunksEmitted++
        try {
          await acquired.session.send(buildSendPayload(acquired.promptToSend, attachments))
          const tSentAt = performance.now()
          for await (const msg of acquired.session.stream()) {
            if (firstSdkMsgAt === 0) firstSdkMsgAt = performance.now()
            debugLog(`[chat] sdk msg type=${msg.type}`)
            if (msg.type === 'assistant') {
              assistantTurnCount++
              assistantText += extractAssistantBlocks(msg as SDKAssistantMessage).text
            }
            const chunks = handleStreamingMessage(converter, msg)
            for (const chunk of chunks) {
              if (firstChunkAt === 0) firstChunkAt = performance.now()
              await stream.writeSSE({ data: JSON.stringify(chunk) })
              chunksEmitted++
            }
            if (msg.type === 'result') {
              result = msg as SDKResultMessage
              break
            }
          }
          const upstreamError = resultErrorMessage(result, assistantText)
          if (upstreamError) {
            pool.evictBySession(acquired.session)
            await stream.writeSSE({
              data: JSON.stringify({ error: { message: upstreamError, type: 'upstream_error' } }),
            })
            await stream.writeSSE({ data: '[DONE]' })
            return
          }
          await stream.writeSSE({ data: JSON.stringify(converter.buildFinishChunk()) })
          if (result) {
            await stream.writeSSE({ data: JSON.stringify(converter.buildUsageChunk(result)) })
          }
          await stream.writeSSE({ data: '[DONE]' })
          rememberSession({ pool, model, history, assistantText, session: acquired.session })
          const tEnd = performance.now()
          logTimings({
            requestId,
            poolHit: acquired.reused,
            sendMs: tSentAt - tStart,
            firstSdkMsgMs: firstSdkMsgAt ? firstSdkMsgAt - tSentAt : -1,
            firstChunkMs: firstChunkAt ? firstChunkAt - tStart : -1,
            totalMs: tEnd - tStart,
            chunks: chunksEmitted + 2,
            assistantTurns: assistantTurnCount,
            result,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          debugLog(`[chat] ERROR: ${message}`)
          pool.evictBySession(acquired.session)
          await stream.writeSSE({
            data: JSON.stringify({ error: { message, type: 'server_error' } }),
          })
        }
      })
    }

    const assistantMsgs: SDKAssistantMessage[] = []
    let result: SDKResultMessage | null = null
    let assistantText = ''
    try {
      await acquired.session.send(buildSendPayload(acquired.promptToSend, attachments))
      for await (const msg of acquired.session.stream()) {
        if (msg.type === 'assistant') {
          const m = msg as SDKAssistantMessage
          assistantMsgs.push(m)
          assistantText += extractAssistantBlocks(m).text
        }
        if (msg.type === 'result') {
          result = msg as SDKResultMessage
          break
        }
      }
    } catch (err) {
      pool.evictBySession(acquired.session)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { message, type: 'server_error' } }, 500)
    }

    const upstreamError = resultErrorMessage(result, assistantText)
    if (upstreamError) {
      pool.evictBySession(acquired.session)
      return c.json({ error: { message: upstreamError, type: 'upstream_error' } }, 502)
    }

    rememberSession({ pool, model, history, assistantText, session: acquired.session })

    return c.json(buildNonStreamingResponse({ id: requestId, model, assistantMsgs, result }))
  })

  return app
}

type RuntimeBridgeRequest = Parameters<BotRuntime['run']>[0]

function runtimeSessionKey(
  config: OllamaServerConfig,
  model: string,
  history: HistoryMessage[],
  clientId?: string,
): string {
  if (config.runtimeSessionKey) return config.runtimeSessionKey({ model, history, ...(clientId ? { clientId } : {}) })
  const prefix = history.slice(0, Math.max(0, history.length - 1))
  return `protocol:${config.runtimeBotId ?? 'runtime'}:${clientId ?? hashHistoryPrefix(model, prefix)}`
}

function runtimeRequestId(
  protocol: string,
  model: string,
  history: HistoryMessage[],
  clientId?: string,
): string {
  return `${protocol}:${model}:${clientId ?? hashHistoryPrefix(model, history)}`
}

async function runtimeOllamaStream(
  context: Context,
  runtime: BotRuntime,
  request: RuntimeBridgeRequest,
): Promise<Response> {
  return stream(context, async (output) => {
    let runId: string | undefined
    let emittedText = false
    const buffered: RuntimeEvent[] = []
    const writeEvent = async (event: RuntimeEvent): Promise<void> => {
      if (!runId || event.runId !== runId || event.type !== 'assistant.delta') return
      emittedText = true
      await output.write(`${JSON.stringify(buildTextDeltaFrame(request.model ?? '', event.text))}\n`)
    }
    const unsubscribe = runtime.subscribe((event) => {
      if (!runId) {
        buffered.push(event)
        return
      }
      return writeEvent(event)
    })

    try {
      const handle = runtime.start(request)
      runId = handle.runId
      for (const event of buffered.splice(0)) await writeEvent(event)
      const result = await handle.result
      if (result.status !== 'completed') {
        await output.write(`${JSON.stringify({ error: result.error ?? 'bot run failed' })}\n`)
        return
      }
      if (!emittedText && result.output) {
        await output.write(`${JSON.stringify(buildTextDeltaFrame(request.model ?? '', result.output))}\n`)
      }
      await output.write(`${JSON.stringify(buildDoneFrame({
        model: request.model ?? '',
        blocks: { text: '', toolUses: [], stopReason: 'end_turn' },
        result: null,
      }))}\n`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await output.write(`${JSON.stringify({ error: message })}\n`)
    } finally {
      unsubscribe()
    }
  })
}

async function runtimeOpenAIStream(
  context: Context,
  runtime: BotRuntime,
  request: RuntimeBridgeRequest,
  requestId: string,
  model: string,
): Promise<Response> {
  return streamSSE(context, async (output) => {
    const converter = new StreamingChunkConverter(requestId, model)
    let runId: string | undefined
    let emittedText = false
    const buffered: RuntimeEvent[] = []
    const writeChunk = async (chunk: OpenAIChatCompletionChunk): Promise<void> => {
      emittedText = true
      await output.writeSSE({ data: JSON.stringify(chunk) })
    }
    const writeEvent = async (event: RuntimeEvent): Promise<void> => {
      if (!runId || event.runId !== runId || event.type !== 'assistant.delta') return
      for (const chunk of converter.fromAssistantMessage(runtimeAssistantMessage(event.text))) {
        await writeChunk(chunk)
      }
    }
    const unsubscribe = runtime.subscribe((event) => {
      if (!runId) {
        buffered.push(event)
        return
      }
      return writeEvent(event)
    })

    try {
      await output.writeSSE({ data: JSON.stringify(converter.buildRoleChunk()) })
      const handle = runtime.start(request)
      runId = handle.runId
      for (const event of buffered.splice(0)) await writeEvent(event)
      const result = await handle.result
      if (result.status !== 'completed') {
        await output.writeSSE({ data: JSON.stringify({ error: { message: result.error ?? 'bot run failed', type: 'upstream_error' } }) })
        return
      }
      if (!emittedText && result.output) {
        for (const chunk of converter.fromAssistantMessage(runtimeAssistantMessage(result.output))) {
          await writeChunk(chunk)
        }
      }
      await output.writeSSE({ data: JSON.stringify(converter.buildFinishChunk()) })
      await output.writeSSE({ data: '[DONE]' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await output.writeSSE({ data: JSON.stringify({ error: { message, type: 'server_error' } }) })
    } finally {
      unsubscribe()
    }
  })
}

function runtimeAssistantMessage(text: string): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }], stop_reason: null },
  } as unknown as SDKAssistantMessage
}

function buildRuntimeOpenAIResponse(
  id: string,
  model: string,
  output: string,
): OpenAIChatCompletionResponse {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: output || null },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * Look the session up in the pool by client-history prefix hash. On hit,
 * returns the existing session and the prompt becomes the *last user message
 * only* — the session already holds the prior turns. On miss, spawns a fresh
 * session and the prompt is the full transcript built from history.
 */
function acquireOrCreate(args: {
  pool: SessionPool
  config: OllamaServerConfig
  model: string
  effectiveSystem: string | undefined
  history: HistoryMessage[]
  fullPrompt: string
}): { session: V2Session; promptToSend: string; reused: boolean } {
  const { pool, config, model, effectiveSystem, history, fullPrompt } = args
  const lastUserIdx = lastIndexOf(history, (m) => m.role === 'user')
  const prefix = lastUserIdx >= 0 ? history.slice(0, lastUserIdx) : history
  const prefixHash = hashHistoryPrefix(model, prefix)
  const existing = pool.acquire(prefixHash)
  if (existing) {
    const lastUser = lastUserIdx >= 0 ? history[lastUserIdx] : undefined
    const promptToSend =
      lastUser && typeof lastUser.content === 'string' ? lastUser.content : ''
    return { session: existing, promptToSend, reused: true }
  }
  const session = createV2Session({
    model,
    cwd: config.cwd ?? process.cwd(),
    systemPrompt: effectiveSystem,
    settingSources: config.settingSources ?? [],
    permissionMode: config.permissionMode ?? 'bypassPermissions',
    allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions ?? true,
    maxTurns: config.maxTurns ?? 10,
    ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
    includePartialMessages: true,
    env: {
      ...process.env,
      ...RECOMMENDED_SUBPROCESS_ENV,
      // Bridge sessions hold full conversation state across pool reuses;
      // aggressive autocompact (=5) thrashes when Copilot ships big prompts.
      // 95 = effectively disabled.
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '95',
    },
    ...config.extraSessionOptions,
  })
  return { session, promptToSend: fullPrompt, reused: false }
}

/**
 * Re-key the session in the pool under the post-turn prefix hash so the next
 * request's prefix lookup hits. assistantText is the accumulated visible text
 * for the just-finished turn (matches the client's view of the assistant
 * message — tool_use blocks are intentionally stripped).
 */
function rememberSession(args: {
  pool: SessionPool
  model: string
  history: HistoryMessage[]
  assistantText: string
  session: V2Session
}): void {
  const { pool, model, history, assistantText, session } = args
  const nextPrefix: HistoryMessage[] = [
    ...history,
    { role: 'assistant', content: assistantText },
  ]
  const nextHash = hashHistoryPrefix(model, nextPrefix)
  pool.register(nextHash, session)
}

function lastIndexOf<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i
  return -1
}

/**
 * Per-turn diagnostic line. Emit on stderr when OLLAMA_BRIDGE_DEBUG is set.
 * Each metric is the dominant time-eater in one of the failure modes:
 *   - sendMs high  → V2 child process cold start (pool_hit was false)
 *   - firstSdkMsgMs high → Anthropic API cache miss + slow first token
 *   - cache_read=0 → cache miss; high cache_read → cache hit (fast)
 *   - assistantTurns > 1 → agent loop doing tool work (slow by design)
 */
function logTimings(args: {
  requestId: string
  poolHit: boolean
  sendMs: number
  firstSdkMsgMs: number
  firstChunkMs: number
  totalMs: number
  chunks: number
  assistantTurns: number
  result: SDKResultMessage | null
}): void {
  const usage = (args.result && 'usage' in args.result ? args.result.usage : null) as
    | Record<string, unknown>
    | null
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0)
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0)
  const inputTokens = Number(usage?.input_tokens ?? 0)
  const outputTokens = Number(usage?.output_tokens ?? 0)
  const totalInput = inputTokens + cacheRead + cacheWrite
  const cacheHitPct = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0
  debugLog(
    `[chat] done id=${args.requestId} pool_hit=${args.poolHit} ` +
      `send=${args.sendMs.toFixed(0)}ms ` +
      `first_sdk_msg=${args.firstSdkMsgMs.toFixed(0)}ms ` +
      `first_chunk=${args.firstChunkMs.toFixed(0)}ms ` +
      `total=${args.totalMs.toFixed(0)}ms ` +
      `turns=${args.assistantTurns} chunks=${args.chunks} ` +
      `tokens=${inputTokens}+${cacheRead}r+${cacheWrite}w/${outputTokens} ` +
      `cache_hit=${cacheHitPct}%`,
  )
}

/**
 * Map an SDK message to zero-or-more OpenAI chunks.
 * - `stream_event` → forward partial deltas (preferred path; only fires when V2
 *   session honours `includePartialMessages: true`).
 * - `assistant` → fallback. Streaming-input sessions dispatch complete assistant
 *   messages without partial events; we synthesise the equivalent delta
 *   chunks so the client still sees content. Skipped if real stream_event has
 *   already produced output (avoids double-emit on dual-channel SDKs).
 */
function handleStreamingMessage(
  converter: StreamingChunkConverter,
  msg: SDKMessage,
): OpenAIChatCompletionChunk[] {
  if (msg.type === 'stream_event') {
    const chunk = converter.fromStreamEvent(msg.event)
    return chunk ? [chunk] : []
  }
  if (msg.type === 'assistant') {
    return converter.fromAssistantMessage(msg as SDKAssistantMessage)
  }
  return []
}

/** V2Session.close() is a sync void; awaiting + .catch() throws on the result. */
function safeClose(session: V2Session): void {
  try {
    session.close()
  } catch {
    /* already closed or transport gone */
  }
}

const DEBUG = !!process.env.OLLAMA_BRIDGE_DEBUG
function debugLog(line: string): void {
  if (DEBUG) process.stderr.write(`${line}\n`)
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  }
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14)
}

function validateChatRequest(body: OllamaChatRequest): string | null {
  if (!body || typeof body !== 'object') return 'invalid request body'
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return '`messages` must be a non-empty array'
  }
  return null
}

/**
 * Build the V2Session.send() argument. Pure-text turns send a string (V2's
 * fast path); image-bearing final turns send a structured SDKUserMessage with
 * image content blocks ahead of the text so the model gets visual context.
 */
function buildSendPayload(
  prompt: string,
  attachments: ImageAttachment[],
): string | {
  type: 'user'
  message: { role: 'user'; content: Array<Record<string, unknown>> }
  parent_tool_use_id: null
} {
  if (!attachments.length) return prompt

  const content: Array<Record<string, unknown>> = attachments.map((att) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: att.mediaType,
      data: stripDataUrlPrefix(att.base64),
    },
  }))
  if (prompt) content.push({ type: 'text', text: prompt })

  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
}

export interface ServeHandle {
  app: Hono
  stop: () => void
  url: string
  port: number
}

/** Convenience: start the server on Bun. Falls back to FALLBACK_OLLAMA_PORT on EADDRINUSE. */
export function serveOllamaBridge(args: {
  port?: number
  hostname?: string
  config?: OllamaServerConfig
} = {}): ServeHandle {
  const desiredPort = args.port ?? Number(process.env.PORT ?? DEFAULT_OLLAMA_PORT)
  const hostname = args.hostname ?? '127.0.0.1'

  // Pool lives across the lifetime of the bridge process. closeAll() on
  // SIGINT / SIGTERM / explicit stop() so child processes don't dangle.
  const pool = new SessionPool()
  const app = createOllamaServer(args.config ?? {}, pool)

  // Disable Bun's default 10s idleTimeout — Claude cold start + thinking can
  // sit silent for tens of seconds before the first SSE chunk lands, and any
  // mid-stream pause longer than 10s would otherwise cut the connection and
  // surface as ERR_INCOMPLETE_CHUNKED_ENCODING in the client. 0 = no timeout.
  const serveOpts = { port: desiredPort, hostname, fetch: app.fetch, idleTimeout: 0 } as const
  let server: ReturnType<typeof Bun.serve>
  let actualPort = desiredPort
  try {
    server = Bun.serve(serveOpts)
  } catch (err) {
    if (isAddrInUse(err) && desiredPort === DEFAULT_OLLAMA_PORT) {
      server = Bun.serve({ ...serveOpts, port: FALLBACK_OLLAMA_PORT })
      actualPort = FALLBACK_OLLAMA_PORT
    } else {
      throw err
    }
  }

  const stop = () => {
    pool.closeAll()
    server.stop()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  return {
    app,
    stop,
    url: `http://${hostname}:${actualPort}`,
    port: actualPort,
  }
}

function isAddrInUse(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EADDRINUSE'
}
