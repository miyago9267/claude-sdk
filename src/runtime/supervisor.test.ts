import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeEventBus } from './events.ts'
import { InMemorySessionStore, SessionRegistry } from './sessions.ts'
import { FileRunStore, InMemoryRunStore, RunSupervisor } from './supervisor.ts'

const request = {
  botId: 'bot-1',
  sessionKey: 'bot-1:user-1',
  trigger: 'message' as const,
  idempotencyKey: 'message-1',
}

describe('RunSupervisor', () => {
  test('runs a job, emits lifecycle events, and persists the session', async () => {
    const bus = new RuntimeEventBus()
    const events: string[] = []
    bus.subscribe((event) => events.push(event.type))
    const registry = new SessionRegistry(new InMemorySessionStore())
    const supervisor = new RunSupervisor({ registry, events: bus })

    const result = await supervisor.submit(request, async ({ session }) => ({
      output: `session:${session.sessionKey}`,
    }))

    expect(result.status).toBe('completed')
    expect(result.output).toBe('session:bot-1:user-1')
    expect(events).toEqual(['run.queued', 'run.started', 'run.completed'])
    expect((await registry.get(request.sessionKey))?.status).toBe('active')
  })

  test('deduplicates a repeated idempotency key', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
    })
    let executions = 0

    const handler = async () => {
      executions += 1
      await Promise.resolve()
      return { output: 'once' }
    }
    const [first, second] = await Promise.all([
      supervisor.submit(request, handler),
      supervisor.submit(request, handler),
    ])

    expect(executions).toBe(1)
    expect(first.runId).toBe(second.runId)
  })

  test('serializes concurrent submissions for one session', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      maxConcurrency: 2,
    })
    let active = 0
    let maximum = 0

    const handler = async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return {}
    }

    await Promise.all([
      supervisor.submit({ ...request, idempotencyKey: 'message-2' }, handler),
      supervisor.submit({ ...request, idempotencyKey: 'message-3' }, handler),
    ])

    expect(maximum).toBe(1)
  })

  test('cancels a queued run before execution', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      maxConcurrency: 1,
    })
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = supervisor.submit(request, async () => {
      await blocker
      return {}
    })
    const second = supervisor.submit(
      { ...request, sessionKey: 'bot-1:user-2', idempotencyKey: 'message-4' },
      async () => ({ output: 'should-not-run' }),
    )

    await Promise.resolve()
    const firstRun = supervisor.listRuns().find((run) => run.idempotencyKey === 'message-1')
    expect(firstRun).toBeDefined()
    expect(supervisor.cancel(firstRun!.runId)).toBe(false)
    const secondRun = supervisor.listRuns().find((run) => run.idempotencyKey === 'message-4')
    expect(secondRun).toBeDefined()
    expect(supervisor.cancel(secondRun!.runId)).toBe(true)
    release()

    await first
    expect((await second).status).toBe('cancelled')
  })

  test('retries a retryable failure and records the attempt count', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      maxAttempts: 2,
      shouldRetry: () => true,
    })
    let attempts = 0

    const result = await supervisor.submit(
      { ...request, idempotencyKey: 'message-5' },
      async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary')
        return { output: 'recovered' }
      },
    )

    expect(result.status).toBe('completed')
    expect(attempts).toBe(2)
    expect(supervisor.getRun(result.runId)?.attempt).toBe(2)
  })

  test('can retry rate-limited handlers with the existing retry budget', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      maxAttempts: 2,
      retryRateLimits: true,
    })
    let attempts = 0

    const result = await supervisor.submit(
      { ...request, idempotencyKey: 'message-rate-limit' },
      async () => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error('rate limited'), { status: 429 })
        return { output: 'recovered' }
      },
    )

    expect(result).toMatchObject({ status: 'completed', output: 'recovered' })
    expect(attempts).toBe(2)
  })

  test('fails a run when the handler exceeds the timeout', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      timeoutMs: 1,
    })

    const result = await supervisor.submit(
      { ...request, idempotencyKey: 'message-6' },
      async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return {}
      },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toBe('run timed out')
  })

  test('aborts a running run when cancelled', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
    })
    let runId = ''

    const resultPromise = supervisor.submit(
      { ...request, idempotencyKey: 'message-7' },
      async ({ run, signal }) => {
        runId = run.runId
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return {}
      },
    )
    while (!runId) await Promise.resolve()

    expect(supervisor.cancel(runId)).toBe(true)
    expect((await resultPromise).status).toBe('cancelled')
  })

  test('shuts down queued and running work', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
    })
    let startedResolve!: () => void
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })
    const running = supervisor.submit(
      { ...request, idempotencyKey: 'message-8' },
      async ({ signal }) => {
        startedResolve()
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
        return {}
      },
    )
    await started
    const queued = supervisor.submit(
      { ...request, sessionKey: 'bot-1:user-2', idempotencyKey: 'message-9' },
      async () => ({ output: 'should-not-run' }),
    )

    await supervisor.shutdown()

    expect((await running).status).toBe('cancelled')
    expect((await queued).status).toBe('cancelled')
  })

  test('limits concurrent runs per bot and user', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      maxConcurrency: 4,
      maxConcurrencyPerBot: 1,
      maxConcurrencyPerUser: 1,
    })
    let active = 0
    let maximum = 0
    const handler = async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return {}
    }

    await Promise.all([
      supervisor.submit({ ...request, idempotencyKey: 'message-10', userId: 'user-1' }, handler),
      supervisor.submit({ ...request, idempotencyKey: 'message-11', userId: 'user-2' }, handler),
    ])

    expect(maximum).toBe(1)
  })

  test('fails a run when handler cost exceeds its budget', async () => {
    const supervisor = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
    })

    const result = await supervisor.submit(
      { ...request, idempotencyKey: 'message-12', budgetUSD: 1 },
      async () => ({ output: 'expensive', costUSD: 1.1 }),
    )

    expect(result).toMatchObject({ status: 'failed', error: 'run budget exceeded' })
  })

  test('persists run state and repairs unfinished runs after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-runs-'))
    try {
      const store = new FileRunStore(join(directory, 'runs.json'))
      const first = new RunSupervisor({
        registry: new SessionRegistry(new InMemorySessionStore()),
        maxConcurrency: 1,
        runStore: store,
      })
      const blocker = first.submit(
        { ...request, idempotencyKey: 'message-recovery-blocker' },
        async ({ signal }) => new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
      )
      const queued = first.submit(
        { ...request, sessionKey: 'bot-1:user-2', idempotencyKey: 'message-recovery' },
        async () => ({ output: 'never-called' }),
      )
      const run = first.listRuns().find((item) => item.idempotencyKey === 'message-recovery')
      expect(run?.status).toBe('queued')
      await store.save(run!)
      void queued
      void blocker

      const events = new RuntimeEventBus()
      const eventTypes: string[] = []
      events.subscribe((event) => eventTypes.push(event.type))
      const restarted = new RunSupervisor({
        registry: new SessionRegistry(new InMemorySessionStore()),
        events,
        runStore: store,
      })
      const abandoned = await restarted.repairAbandonedRuns()

      expect(abandoned).toHaveLength(2)
      expect(abandoned.find((item) => item.runId === run!.runId)?.status).toBe('abandoned')
      expect(restarted.getRun(run!.runId)?.error).toBe('process restart')
      expect(eventTypes).toHaveLength(2)
      expect((await store.list()).find((item) => item.runId === run!.runId)?.status).toBe('abandoned')
      first.cancel(run!.runId)
      await first.shutdown()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('repairs in-memory unfinished runs without a file store', async () => {
    const store = new InMemoryRunStore()
    const run = {
      ...request,
      runId: 'recovery-run',
      status: 'running' as const,
      attempt: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await store.save(run)
    const restarted = new RunSupervisor({
      registry: new SessionRegistry(new InMemorySessionStore()),
      runStore: store,
    })
    expect((await restarted.repairAbandonedRuns('test restart')).find((item) => item.runId === run.runId)).toMatchObject({
      runId: run.runId,
      status: 'abandoned',
      error: 'test restart',
    })
  })
})
