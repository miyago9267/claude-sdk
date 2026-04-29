/**
 * Endpoint tests for the static (non-SDK-touching) routes. The /api/chat path
 * spawns a real V2 session under the hood, so it isn't unit-testable without
 * mocking @anthropic-ai/claude-agent-sdk; that's covered by the manual e2e
 * step in PROGRESS.md instead.
 */

import { describe, expect, test } from 'bun:test'

import {
  BRIDGE_VERSION,
  DEFAULT_EXPOSED_MODELS,
  createOllamaServer,
} from './server.ts'

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

  test('POST /api/show returns capabilities including tools', async () => {
    const app = createOllamaServer()
    const req = new Request('http://x/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
    })
    const { status, body } = await fetchJson(app, req)
    expect(status).toBe(200)
    expect((body as { capabilities: string[] }).capabilities).toContain('tools')
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
