import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemorySessionStore, SessionRegistry } from './sessions.ts'
import { FileJobStore, InMemoryJobStore, Scheduler, type JobStore } from './scheduler.ts'
import { RunSupervisor, type RunHandler } from './supervisor.ts'
import { DeliveryRouter, InMemoryDeliveryAdapter } from './delivery.ts'

const makeScheduler = (
  handler: RunHandler,
  store: JobStore = new InMemoryJobStore(),
  now?: () => Date,
) => {
  const supervisor = new RunSupervisor({
    registry: new SessionRegistry(new InMemorySessionStore()),
  })
  return new Scheduler({ store, supervisor, handler: () => handler, ...(now ? { now } : {}) })
}

describe('Scheduler', () => {
  test('runs a due one-shot job once and marks it completed', async () => {
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      return { output: 'done' }
    })
    await scheduler.register({
      id: 'job-1',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'cron',
      schedule: { type: 'once', at: '2026-08-24T09:00:00.000Z' },
      status: 'active',
    })

    const first = await scheduler.tick(new Date('2026-08-24T09:01:00.000Z'))
    const second = await scheduler.tick(new Date('2026-08-24T09:02:00.000Z'))

    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ status: 'completed' })
    expect(second).toHaveLength(0)
    expect(executions).toBe(1)
    expect((await scheduler.get('job-1'))?.status).toBe('completed')
  })

  test('supports pause, resume and manual trigger', async () => {
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      return {}
    })
    await scheduler.register({
      id: 'job-2',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'cron',
      schedule: { type: 'interval', everyMs: 60_000 },
      nextRunAt: '2026-08-24T09:00:00.000Z',
      status: 'active',
    })

    await scheduler.pause('job-2')
    expect(await scheduler.tick(new Date('2026-08-24T09:01:00.000Z'))).toHaveLength(0)
    await scheduler.resume('job-2', new Date('2026-08-24T09:01:00.000Z'))
    expect(await scheduler.trigger('job-2')).toHaveLength(1)
    expect(executions).toBe(1)
  })

  test('does not run an interval job twice while the previous run is active', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      await pending
      return {}
    }, new InMemoryJobStore(), () => new Date('2026-08-24T09:00:00.000Z'))
    await scheduler.register({
      id: 'job-3',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'cron',
      schedule: { type: 'interval', everyMs: 1 },
      nextRunAt: '2026-08-24T09:00:00.000Z',
      status: 'active',
    })

    const first = scheduler.tick(new Date('2026-08-24T09:00:01.000Z'))
    await Promise.resolve()
    const second = await scheduler.tick(new Date('2026-08-24T09:00:02.000Z'))
    expect(second).toHaveLength(0)
    release()
    await first
    expect(executions).toBe(1)
  })

  test('persists jobs through a file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-jobs-'))
    const store = new FileJobStore(directory)
    const scheduler = makeScheduler(async () => ({}), store)
    await scheduler.register({
      id: 'job-4',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'job',
      schedule: { type: 'once', at: '2026-08-24T09:00:00.000Z' },
      status: 'active',
    })

    expect(await store.get('job-4')).toMatchObject({ id: 'job-4', status: 'active' })
  })

  test('edits a job and recalculates the next interval run', async () => {
    const scheduler = makeScheduler(async () => ({}), new InMemoryJobStore(), () => new Date('2026-08-24T09:00:00.000Z'))
    await scheduler.register({
      id: 'job-5',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'cron',
      schedule: { type: 'interval', everyMs: 60_000 },
      status: 'active',
    })

    const edited = await scheduler.edit('job-5', {
      schedule: { type: 'interval', everyMs: 120_000 },
      deliveryTarget: 'memory:inbox',
    })

    expect(edited).toMatchObject({
      schedule: { type: 'interval', everyMs: 120_000 },
      nextRunAt: '2026-08-24T09:02:00.000Z',
      deliveryTarget: 'memory:inbox',
    })
  })

  test('starts and stops the external scheduler driver', async () => {
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      return {}
    }, new InMemoryJobStore(), () => new Date('2026-08-24T09:00:00.000Z'))
    await scheduler.register({
      id: 'job-6',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'job',
      schedule: { type: 'once', at: '2026-08-24T08:59:00.000Z' },
      status: 'active',
    })

    scheduler.start(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.stop()

    expect(executions).toBe(1)
    expect((await scheduler.get('job-6'))?.status).toBe('completed')
  })

  test('runs a due cron job and schedules its next UTC occurrence', async () => {
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      return { output: 'cron result' }
    }, new InMemoryJobStore(), () => new Date('2026-08-24T09:30:00.000Z'))
    await scheduler.register({
      id: 'job-7',
      botId: 'bot-1',
      sessionKey: 'bot-1:cron',
      trigger: 'cron',
      schedule: { type: 'cron', expression: '30 9 * * *' },
      nextRunAt: '2026-08-24T09:30:00.000Z',
      status: 'active',
    })

    const results = await scheduler.tick(new Date('2026-08-24T09:30:00.000Z'))

    expect(results).toHaveLength(1)
    expect(executions).toBe(1)
    expect((await scheduler.get('job-7'))?.nextRunAt).toBe('2026-08-25T09:30:00.000Z')
  })

  test('skips heartbeat jobs outside the configured UTC active window', async () => {
    let executions = 0
    const scheduler = makeScheduler(async () => {
      executions += 1
      return {}
    }, new InMemoryJobStore(), () => new Date('2026-08-24T22:00:00.000Z'))
    await scheduler.register({
      id: 'job-8',
      botId: 'bot-1',
      sessionKey: 'bot-1:heartbeat',
      trigger: 'heartbeat',
      schedule: { type: 'heartbeat', everyMs: 60_000, activeHoursUtc: { startHour: 9, endHour: 18 } },
      nextRunAt: '2026-08-24T22:00:00.000Z',
      status: 'active',
    })

    expect(await scheduler.tick(new Date('2026-08-24T22:00:00.000Z'))).toHaveLength(0)
    expect(executions).toBe(0)
    expect((await scheduler.get('job-8'))?.nextRunAt).toBe('2026-08-24T22:01:00.000Z')
  })

  test('uses an isolated job session and delivers completed output', async () => {
    const adapter = new InMemoryDeliveryAdapter('memory:')
    const delivery = new DeliveryRouter({ adapters: [adapter] })
    const isolatedScheduler = new Scheduler({
      store: new InMemoryJobStore(),
      supervisor: new RunSupervisor({ registry: new SessionRegistry(new InMemorySessionStore()) }),
      handler: () => async ({ session }) => ({ output: session.sessionKey }),
      delivery,
    })
    await isolatedScheduler.register({
      id: 'job-9',
      botId: 'bot-1',
      sessionKey: 'bot-1:shared',
      sessionMode: 'isolated',
      trigger: 'job',
      schedule: { type: 'once', at: '2026-08-24T09:00:00.000Z' },
      deliveryTarget: 'memory:inbox',
      status: 'active',
    })

    const results = await isolatedScheduler.tick(new Date('2026-08-24T09:01:00.000Z'))

    expect(results[0]?.status).toBe('completed')
    expect(adapter.messages[0]?.event).toMatchObject({ type: 'run.completed' })
    expect(adapter.messages[0]?.event).toMatchObject({ output: 'bot-1:shared:job:job-9' })
  })
})
