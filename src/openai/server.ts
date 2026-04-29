/**
 * Hono server exposing an OpenAI Chat Completions compatible endpoint backed
 * by a fresh V2 Claude session per request (stateless adapter, see
 * docs/specs/openai-cli-layers/SPEC.md ADR-1).
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
  StreamingChunkConverter,
  buildNonStreamingResponse,
  buildPromptFromOpenAIMessages,
} from './transform.ts'
import type {
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIModelsResponse,
} from './types.ts'

export interface OpenAIServerConfig {
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

const DEFAULT_EXPOSED_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]

export function createOpenAIServer(config: OpenAIServerConfig = {}): Hono {
  const app = new Hono()
  app.use('*', cors())

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.get('/v1/models', (c) => {
    const ids = config.exposedModels?.length ? config.exposedModels : DEFAULT_EXPOSED_MODELS
    const body: OpenAIModelsResponse = {
      object: 'list',
      data: ids.map((id) => ({
        id,
        object: 'model' as const,
        created: 0,
        owned_by: 'anthropic',
      })),
    }
    return c.json(body)
  })

  app.post('/v1/chat/completions', async (c) => {
    let body: OpenAIChatCompletionRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }, 400)
    }

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        { error: { message: '`messages` must be a non-empty array', type: 'invalid_request_error' } },
        400,
      )
    }

    const requestId = `chatcmpl-${cryptoRandom()}`
    const model = body.model || config.defaultModel || 'claude-sonnet-4-6'
    const { systemPrompt, prompt } = buildPromptFromOpenAIMessages(body.messages)
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

        await stream.writeSSE({ data: serialise(converter.buildRoleChunk()) })

        try {
          await session.send(prompt)
          for await (const msg of session.stream()) {
            const chunk = handleStreamingMessage(converter, msg)
            if (chunk) await stream.writeSSE({ data: serialise(chunk) })
            if (msg.type === 'result') {
              result = msg as SDKResultMessage
              break
            }
          }
          await stream.writeSSE({ data: serialise(converter.buildFinishChunk()) })
          if (result) {
            await stream.writeSSE({ data: serialise(converter.buildUsageChunk(result)) })
          }
          await stream.writeSSE({ data: '[DONE]' })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          await stream.writeSSE({
            data: JSON.stringify({ error: { message, type: 'server_error' } }),
          })
        } finally {
          await session.close().catch(() => {})
        }
      })
    }

    const assistantMsgs: SDKAssistantMessage[] = []
    let result: SDKResultMessage | null = null
    try {
      await session.send(prompt)
      for await (const msg of session.stream()) {
        if (msg.type === 'assistant') assistantMsgs.push(msg as SDKAssistantMessage)
        if (msg.type === 'result') {
          result = msg as SDKResultMessage
          break
        }
      }
    } catch (err) {
      await session.close().catch(() => {})
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: { message, type: 'server_error' } }, 500)
    }
    await session.close().catch(() => {})

    const response = buildNonStreamingResponse({
      id: requestId,
      model,
      request: body,
      assistantMsgs,
      result,
    })
    return c.json(response)
  })

  return app
}

function handleStreamingMessage(
  converter: StreamingChunkConverter,
  msg: SDKMessage,
): OpenAIChatCompletionChunk | null {
  if (msg.type === 'stream_event') {
    return converter.fromStreamEvent(msg.event)
  }
  return null
}

function serialise(chunk: OpenAIChatCompletionChunk): string {
  return JSON.stringify(chunk)
}

function cryptoRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  }
  return Math.random().toString(36).slice(2, 14) + Math.random().toString(36).slice(2, 14)
}

/** Convenience: start the server on Bun. */
export function serveOpenAIAdapter(args: {
  port?: number
  hostname?: string
  config?: OpenAIServerConfig
} = {}): { app: Hono; stop: () => void; url: string } {
  const port = args.port ?? Number(process.env.PORT ?? 4141)
  const hostname = args.hostname ?? '127.0.0.1'
  const app = createOpenAIServer(args.config ?? {})
  const server = Bun.serve({
    port,
    hostname,
    fetch: app.fetch,
  })
  return {
    app,
    stop: () => server.stop(),
    url: `http://${hostname}:${port}`,
  }
}
