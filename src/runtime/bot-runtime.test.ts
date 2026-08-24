import { describe, expect, test } from 'bun:test'
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import { AuditRecorder, InMemoryAuditStore } from './audit.ts'
import { BotRegistry } from './bots.ts'
import { BotRuntime } from './bot-runtime.ts'
import { DeliveryRouter, InMemoryDeliveryAdapter } from './delivery.ts'
import { RuntimeEventBus } from './events.ts'
import { InMemorySessionStore, SessionRegistry } from './sessions.ts'
import { RunSupervisor } from './supervisor.ts'

function fakeQueryFactory(calls: Array<{ prompt: unknown; options: Record<string, unknown> }>) {
  return ({ prompt, options }: { prompt: unknown; options?: Record<string, unknown> }): Query => {
    calls.push({ prompt, options: options ?? {} })
    const stream = (async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello from bot' },
            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file: 'README.md' } },
          ],
          stop_reason: 'tool_use',
        },
      } as SDKMessage
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'hello from bot',
        total_cost_usd: 0.01,
        session_id: `sdk-session-${calls.length}`,
      } as SDKMessage
    })()

    return Object.assign(stream, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      initializationResult: async () => ({}),
      supportedCommands: async () => [],
      supportedModels: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      accountInfo: async () => ({}),
      rewindFiles: async () => ({}),
      reconnectMcpServer: async () => undefined,
      toggleMcpServer: async () => undefined,
      setMcpServers: async () => ({}),
      streamInput: async () => undefined,
      stopTask: async () => undefined,
      close: () => undefined,
    }) as unknown as Query
  }
}

describe('BotRuntime', () => {
  test('assembles a manual run through SDK, events, audit, delivery and session resume', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = []
    const events = new RuntimeEventBus()
    const auditStore = new InMemoryAuditStore()
    const audit = new AuditRecorder(events, auditStore)
    audit.start()
    const adapter = new InMemoryDeliveryAdapter('test:')
    const delivery = new DeliveryRouter({ adapters: [adapter], eventBus: events })
    const registry = new BotRegistry()
    registry.register({ id: 'writer', workspace: process.cwd(), systemPrompt: 'Be concise.' })
    const sessions = new SessionRegistry(new InMemorySessionStore())
    const runtime = new BotRuntime({
      registry,
      sessions,
      supervisor: new RunSupervisor({ registry: sessions, events }),
      events,
      delivery,
      query: fakeQueryFactory(calls),
    })

    const first = await runtime.run({
      botId: 'writer',
      sessionKey: 'writer:user-1',
      trigger: 'message',
      idempotencyKey: 'message-1',
      prompt: 'hello',
      deliveryTarget: 'test:user-1',
    })
    const second = await runtime.run({
      botId: 'writer',
      sessionKey: 'writer:user-1',
      trigger: 'message',
      idempotencyKey: 'message-2',
      prompt: 'continue',
    })

    expect(first).toMatchObject({ status: 'completed', output: 'hello from bot', costUSD: 0.01 })
    expect(second.status).toBe('completed')
    expect(calls[0]).toMatchObject({ prompt: 'hello' })
    expect(calls[0]?.options).not.toHaveProperty('resume')
    expect(calls[1]?.options.resume).toBe('sdk-session-1')
    expect(adapter.messages).toHaveLength(1)
    expect(adapter.messages[0]?.event.type).toBe('run.completed')

    const recorded = await auditStore.listByRun(first.runId)
    expect(recorded.map((record) => record.eventType)).toEqual(expect.arrayContaining([
      'run.queued',
      'run.started',
      'assistant.delta',
      'tool.started',
      'run.completed',
      'delivery.sent',
    ]))
  })

  test('fails before submission when the bot manifest is unknown', async () => {
    const runtime = new BotRuntime({
      registry: new BotRegistry(),
      sessions: new SessionRegistry(new InMemorySessionStore()),
      query: fakeQueryFactory([]),
    })

    await expect(runtime.run({
      botId: 'missing',
      sessionKey: 'missing:session',
      trigger: 'message',
      prompt: 'hello',
    })).rejects.toThrow('unknown bot: missing')
  })

  test('propagates supervisor timeout cancellation to the SDK query', async () => {
    let querySignal: AbortSignal | undefined
    const runtime = new BotRuntime({
      registry: (() => {
        const registry = new BotRegistry()
        registry.register({ id: 'slow', workspace: process.cwd() })
        return registry
      })(),
      sessions: new SessionRegistry(new InMemorySessionStore()),
      supervisorOptions: { timeoutMs: 10 },
      query: ({ options }) => {
        querySignal = options?.abortController?.signal
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          await new Promise<void>((resolve) => querySignal?.addEventListener('abort', () => resolve(), { once: true }))
        })()
        return Object.assign(stream, { close: () => undefined }) as unknown as Query
      },
    })

    const result = await runtime.run({
      botId: 'slow',
      sessionKey: 'slow:session',
      trigger: 'message',
      prompt: 'wait',
    })

    expect(result).toMatchObject({ status: 'failed', error: 'run timed out' })
    expect(querySignal?.aborted).toBe(true)
  })
})
