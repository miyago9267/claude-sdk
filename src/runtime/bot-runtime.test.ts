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

  test('deduplicates delivery when the same idempotency key is submitted twice', async () => {
    const calls: Array<{ prompt: unknown; options: Record<string, unknown> }> = []
    const adapter = new InMemoryDeliveryAdapter('test:')
    const registry = new BotRegistry()
    registry.register({ id: 'writer', workspace: process.cwd() })
    const runtime = new BotRuntime({
      registry,
      sessions: new SessionRegistry(new InMemorySessionStore()),
      delivery: new DeliveryRouter({ adapters: [adapter] }),
      query: fakeQueryFactory(calls),
    })

    const [first, second] = await Promise.all([
      runtime.run({
        botId: 'writer',
        sessionKey: 'writer:user-1',
        trigger: 'message',
        idempotencyKey: 'same-message',
        prompt: 'hello',
        deliveryTarget: 'test:user-1',
      }),
      runtime.run({
        botId: 'writer',
        sessionKey: 'writer:user-1',
        trigger: 'message',
        idempotencyKey: 'same-message',
        prompt: 'hello',
        deliveryTarget: 'test:user-1',
      }),
    ])

    expect(first.runId).toBe(second.runId)
    expect(calls).toHaveLength(1)
    expect(adapter.messages).toHaveLength(1)
  })

  test('applies manifest denial and runtime approval through the public run path', async () => {
    const decisions: Array<{ behavior: string }> = []
    const query = ({ options }: { options?: Record<string, any> }): Query => {
      const stream = (async function* (): AsyncGenerator<SDKMessage> {
        const decision = await options?.canUseTool?.('Bash', { command: 'echo hi' }, {
          signal: new AbortController().signal,
        })
        decisions.push(decision)
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'checked',
          total_cost_usd: 0,
          session_id: 'sdk-policy-session',
        } as SDKMessage
      })()
      return Object.assign(stream, { close: () => undefined }) as unknown as Query
    }
    const registry = new BotRegistry()
    registry.register({
      id: 'deny-bot',
      workspace: process.cwd(),
      policy: { defaultDecision: 'deny', rules: [] },
    })
    registry.register({
      id: 'approval-bot',
      workspace: process.cwd(),
      policy: { defaultDecision: 'ask-human', rules: [] },
    })
    const runtime = new BotRuntime({
      registry,
      sessions: new SessionRegistry(new InMemorySessionStore()),
      approval: async () => 'allow',
      query,
    })

    await runtime.run({ botId: 'deny-bot', sessionKey: 'deny', trigger: 'message', prompt: 'check' })
    await runtime.run({ botId: 'approval-bot', sessionKey: 'approval', trigger: 'message', prompt: 'check' })

    expect(decisions).toEqual([
      expect.objectContaining({ behavior: 'deny' }),
      expect.objectContaining({ behavior: 'allow' }),
    ])
  })

  test('exposes live Query controls through a BotRunHandle', async () => {
    let started!: () => void
    const queryStarted = new Promise<void>((resolve) => { started = resolve })
    let selectedModel: string | undefined
    let selectedPermissionMode: string | undefined
    let selectedThinkingTokens: number | undefined
    const registry = new BotRegistry()
    registry.register({ id: 'control-bot', workspace: process.cwd() })
    const runtime = new BotRuntime({
      registry,
      sessions: new SessionRegistry(new InMemorySessionStore()),
      query: ({ options }) => {
        const stream = (async function* (): AsyncGenerator<SDKMessage> {
          started()
          await new Promise<void>((resolve) => options?.abortController?.signal.addEventListener('abort', () => resolve(), { once: true }))
        })()
        return Object.assign(stream, {
          interrupt: async () => options?.abortController?.abort('interrupt'),
          setModel: async (model?: string) => { selectedModel = model },
          setPermissionMode: async (mode: string) => { selectedPermissionMode = mode },
          setMaxThinkingTokens: async (tokens?: number) => { selectedThinkingTokens = tokens },
          close: () => undefined,
        }) as unknown as Query
      },
    })

    const handle = runtime.start({
      botId: 'control-bot',
      sessionKey: 'control',
      trigger: 'message',
      prompt: 'wait',
    })
    await queryStarted
    expect(await handle.setModel('sonnet')).toBe(true)
    expect(await handle.setPermissionMode('default')).toBe(true)
    expect(await handle.setMaxThinkingTokens(1024)).toBe(true)
    expect(selectedModel).toBe('sonnet')
    expect(selectedPermissionMode).toBe('default')
    expect(selectedThinkingTokens).toBe(1024)
    expect(handle.cancel()).toBe(true)
    await expect(handle.result).resolves.toMatchObject({ status: 'cancelled' })
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
