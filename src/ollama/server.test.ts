/**
 * Endpoint tests for the static (non-SDK-touching) routes. The /api/chat path
 * spawns a real V2 session under the hood, so it isn't unit-testable without
 * mocking @anthropic-ai/claude-agent-sdk; that's covered by the manual e2e
 * step in PROGRESS.md instead.
 */

import { describe, expect, test } from 'bun:test'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import {
  BRIDGE_VERSION,
  DEFAULT_EXPOSED_MODELS,
  createOllamaServer,
} from './server.ts'
import { BotRegistry } from '../runtime/bots.ts'
import { BotRuntime } from '../runtime/bot-runtime.ts'
import { RuntimeEventBus } from '../runtime/events.ts'
import { InMemorySessionStore, SessionRegistry } from '../runtime/sessions.ts'

function makeRuntime(options: { events?: RuntimeEventBus } = {}) {
  const calls: Array<{ prompt: unknown; systemPrompt?: unknown }> = []
  const registry = new BotRegistry()
  registry.register({ id: 'bridge-bot', workspace: process.cwd() })
  const runtime = new BotRuntime({
    registry,
    sessions: new SessionRegistry(new InMemorySessionStore()),
    ...(options.events ? { events: options.events } : {}),
    query: ({ prompt, options: queryOptions }) => {
      calls.push({ prompt, systemPrompt: queryOptions?.systemPrompt })
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'runtime bridge output' }], stop_reason: 'end_turn' },
        } as SDKMessage
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'runtime bridge output',
          total_cost_usd: 0,
          session_id: `bridge-session-${calls.length}`,
        } as SDKMessage
      })()
      return Object.assign(stream, { close: () => undefined }) as unknown as Query
    },
  })
  return { runtime, calls }
}

async function fetchJson(app: ReturnType<typeof createOllamaServer>, req: Request): Promise<{
  status: number
  body: unknown
}> {
  const res = await app.fetch(req)
  const body = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : await res.text()
  return { status: res.status, body }
}

describe('Ollama bridge endpoints', () => {
  test('routes OpenAI non-streaming requests through BotRuntime', async () => {
    const { runtime, calls } = makeRuntime()
    const app = createOllamaServer({ runtime, runtimeBotId: 'bridge-bot' })
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'system', content: 'be concise' },
          { role: 'user', content: 'hello' },
        ],
      }),
    })

    const { status, body } = await fetchJson(app, req)

    expect(status).toBe(200)
    expect(body).toMatchObject({ choices: [{ message: { content: 'runtime bridge output' } }] })
    expect(calls).toEqual([{ prompt: 'hello', systemPrompt: 'be concise' }])
  })

  test('routes OpenAI streaming requests through BotRuntime events', async () => {
    const events = new RuntimeEventBus()
    const { runtime } = makeRuntime({ events })
    const app = createOllamaServer({ runtime, runtimeBotId: 'bridge-bot' })
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    const response = await app.fetch(req)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('runtime bridge output')
    expect(body).toContain('[DONE]')
  })

  test('routes Ollama non-streaming requests through BotRuntime', async () => {
    const { runtime } = makeRuntime()
    const app = createOllamaServer({ runtime, runtimeBotId: 'bridge-bot' })
    const req = new Request('http://x/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    })

    const { status, body } = await fetchJson(app, req)

    expect(status).toBe(200)
    expect(body).toMatchObject({ message: { content: 'runtime bridge output' }, done: true })
  })

  test('GET / returns the canonical Ollama root marker', async () => {
    const app = createOllamaServer()
    const res = await app.fetch(new Request('http://x/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Ollama is running')
  })

  test('GET /api/version reports bridge version', async () => {
    const app = createOllamaServer()
    const { status, body } = await fetchJson(app, new Request('http://x/api/version'))
    expect(status).toBe(200)
    expect(body).toEqual({ version: BRIDGE_VERSION })
  })

  test('GET /api/tags lists default Claude models', async () => {
    const app = createOllamaServer()
    const { status, body } = await fetchJson(app, new Request('http://x/api/tags'))
    expect(status).toBe(200)
    const models = (body as { models: { name: string }[] }).models
    expect(models.map((m) => m.name)).toEqual([...DEFAULT_EXPOSED_MODELS])
  })

  test('GET /api/tags honours config.exposedModels override', async () => {
    const app = createOllamaServer({ exposedModels: ['claude-only-one'] })
    const { body } = await fetchJson(app, new Request('http://x/api/tags'))
    const models = (body as { models: { name: string }[] }).models
    expect(models).toHaveLength(1)
    expect(models[0]?.name).toBe('claude-only-one')
  })

  test('POST /api/show advertises tools + vision + thinking', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    })
    const { status, body } = await fetchJson(app, req)
    expect(status).toBe(200)
    const caps = (body as { capabilities: string[] }).capabilities
    expect(caps).toContain('tools')
    expect(caps).toContain('vision')
    expect(caps).toContain('thinking')
  })

  test('POST /api/show 400 on missing model', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const { status } = await fetchJson(app, req)
    expect(status).toBe(400)
  })

  test('POST /api/chat 400 on empty messages', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    const { status } = await fetchJson(app, req)
    expect(status).toBe(400)
  })

  test('GET /v1/models lists same models as /api/tags (OpenAI-compat surface)', async () => {
    const app = createOllamaServer()
    const { status, body } = await fetchJson(app, new Request('http://x/v1/models'))
    expect(status).toBe(200)
    const data = (body as { object: string; data: { id: string }[] }).data
    expect(data.map((m) => m.id)).toEqual([...DEFAULT_EXPOSED_MODELS])
  })

  test('POST /v1/chat/completions 400 on empty messages', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    const { status } = await fetchJson(app, req)
    expect(status).toBe(400)
  })

  test('POST /v1/chat/completions 400 on invalid JSON', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    const { status } = await fetchJson(app, req)
    expect(status).toBe(400)
  })

  test('POST /api/chat 501 when stream=true (Phase 1 not yet implemented)', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })
    const { status } = await fetchJson(app, req)
    expect(status).toBe(501)
  })
})
