/**
 * Hono server exposing the Ollama-native HTTP API backed by Claude SDK V2
 * sessions. GitHub Copilot Chat and similar tools that target a local Ollama
 * install can point at this server unmodified.
 *
 * Phase 1 scope: /api/version, /api/tags, /api/show, non-streaming /api/chat.
 * Streaming + session pool + tool/thinking forwarding land in later phases.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'

import {
  unstable_v2_createSession,
  type PermissionMode,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKSession,
  type SDKSessionOptions,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk'

import { RECOMMENDED_SUBPROCESS_ENV } from '../context-manager.ts'
import {
  extractAssistantBlocks,
  stripDataUrlPrefix,
  type ImageAttachment,
} from '../shared/messages.ts'
import {
  StreamingChunkConverter,
  attachmentsFromHistory,
  buildNonStreamingResponse,
  buildPromptFromOpenAIMessages,
  openAIMessagesToHistory,
  type OpenAIChatCompletionChunk,
  type OpenAIChatCompletionRequest,
  type OpenAIModelsResponse,
} from './openai-compat.ts'
import {
  buildDoneFrame,
  buildPromptFromOllamaMessages,
  buildShowResponse,
  buildTagsResponse,
} from './transform.ts'
import type {
  OllamaChatRequest,
  OllamaShowRequest,
  OllamaVersionResponse,
} from './types.ts'

export const DEFAULT_OLLAMA_PORT = 11434
export const FALLBACK_OLLAMA_PORT = 41434
// VS Code GitHub Copilot enforces a minimum Ollama version (>= 0.6.4 as of
// 2026-04-29) and rejects anything lower. The string must be a plain semver
// — pre-release suffixes like `-claude-bridge` get parsed and may also fail
// the floor check. Keep this comfortably ahead of the floor; bump if Copilot
// raises it. Bridge identity lives in the `/` root marker instead.
export const BRIDGE_VERSION = '0.10.0'

export const DEFAULT_EXPOSED_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const

export interface OllamaServerConfig {
  defaultModel?: string
  cwd?: string
  systemPromptOverride?: string
  settingSources?: SettingSource[]
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  maxTurns?: number
  exposedModels?: string[]
  extraSessionOptions?: Partial<SDKSessionOptions>
}

export function createOllamaServer(config: OllamaServerConfig = {}): Hono {
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

    if (body.stream === true) {
      return c.json(
        { error: 'streaming is not implemented in Phase 1; pass "stream": false' },
        501,
      )
    }

    const session = unstable_v2_createSession({
      model,
      cwd: config.cwd ?? process.cwd(),
      systemPrompt: effectiveSystem,
      settingSources: config.settingSources ?? [],
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions ?? true,
      maxTurns: config.maxTurns ?? 10,
      includePartialMessages: false,
      env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
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
    const { systemPrompt, prompt } = buildPromptFromOpenAIMessages(body.messages)
    const attachments = attachmentsFromHistory(history)
    const effectiveSystem = config.systemPromptOverride ?? systemPrompt ?? undefined

    const session = unstable_v2_createSession({
      model,
      cwd: config.cwd ?? process.cwd(),
      systemPrompt: effectiveSystem,
      settingSources: config.settingSources ?? [],
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions ?? true,
      maxTurns: config.maxTurns ?? 10,
      includePartialMessages: body.stream === true,
      env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
      ...config.extraSessionOptions,
    })

    if (body.stream) {
      return streamSSE(c, async (stream) => {
        const converter = new StreamingChunkConverter(requestId, model)
        let result: SDKResultMessage | null = null
        let chunksEmitted = 0
        debugLog(`[stream] start id=${requestId} model=${model} prompt_len=${prompt.length} attachments=${attachments.length}`)
        await stream.writeSSE({ data: JSON.stringify(converter.buildRoleChunk()) })
        chunksEmitted++
        try {
          await session.send(buildSendPayload(prompt, attachments))
          debugLog(`[stream] send ok, awaiting first SDK message`)
          for await (const msg of session.stream()) {
            debugLog(`[stream] sdk msg type=${msg.type}`)
            const chunks = handleStreamingMessage(converter, msg)
            for (const chunk of chunks) {
              await stream.writeSSE({ data: JSON.stringify(chunk) })
              chunksEmitted++
            }
            if (msg.type === 'result') {
              result = msg as SDKResultMessage
              break
            }
          }
          await stream.writeSSE({ data: JSON.stringify(converter.buildFinishChunk()) })
          if (result) {
            await stream.writeSSE({ data: JSON.stringify(converter.buildUsageChunk(result)) })
          }
          await stream.writeSSE({ data: '[DONE]' })
          debugLog(`[stream] done, chunks_emitted=${chunksEmitted + 2}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          debugLog(`[stream] ERROR: ${message}`)
          await stream.writeSSE({
            data: JSON.stringify({ error: { message, type: 'server_error' } }),
          })
        } finally {
          safeClose(session)
        }
      })
    }

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
      return c.json({ error: { message, type: 'server_error' } }, 500)
    }
    safeClose(session)

    return c.json(buildNonStreamingResponse({ id: requestId, model, assistantMsgs, result }))
  })

  return app
}

/**
 * Map an SDK message to zero-or-more OpenAI chunks.
 * - `stream_event` → forward partial deltas (preferred path; only fires when V2
 *   session honours `includePartialMessages: true`).
 * - `assistant` → fallback. Patched V2 sessions dispatch complete assistant
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

/** SDKSession.close() is a sync void; awaiting + .catch() throws on the result. */
function safeClose(session: SDKSession): void {
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
 * Build the SDKSession.send() argument. Pure-text turns send a string (V2's
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
  const app = createOllamaServer(args.config ?? {})

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

  return {
    app,
    stop: () => server.stop(),
    url: `http://${hostname}:${actualPort}`,
    port: actualPort,
  }
}

function isAddrInUse(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return code === 'EADDRINUSE'
}
