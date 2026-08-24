import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeEventBus, type RuntimeEvent } from './events.ts'
import { AuditRecorder, FileAuditStore, InMemoryAuditStore, exportAuditJsonl } from './audit.ts'

const event: RuntimeEvent = {
  eventId: 'event-1',
  runId: 'run-1',
  occurredAt: '2026-08-24T09:00:00.000Z',
  type: 'permission.requested',
  toolName: 'Bash',
  input: {
    command: 'deploy',
    token: 'secret-token',
    nested: { password: 'secret-password', safe: 'kept' },
  },
}

describe('AuditRecorder', () => {
  test('records events and redacts sensitive fields by default', async () => {
    const bus = new RuntimeEventBus()
    const store = new InMemoryAuditStore()
    const recorder = new AuditRecorder(bus, store)
    recorder.start()

    await bus.publish(event)

    const records = await store.listByRun('run-1')
    expect(records).toHaveLength(1)
    expect(records[0]?.event).toMatchObject({
      type: 'permission.requested',
      input: {
        token: '[REDACTED]',
        nested: { password: '[REDACTED]', safe: 'kept' },
      },
    })
    expect(JSON.stringify(records[0])).not.toContain('secret-token')
    recorder.stop()
  })

  test('stops recording after unsubscribe', async () => {
    const bus = new RuntimeEventBus()
    const store = new InMemoryAuditStore()
    const recorder = new AuditRecorder(bus, store)
    recorder.start()
    recorder.stop()

    await bus.publish(event)

    expect(await store.list()).toHaveLength(0)
  })
})

describe('FileAuditStore', () => {
  test('persists append-only JSONL records and filters by run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-audit-'))
    const store = new FileAuditStore(directory)
    const bus = new RuntimeEventBus()
    const recorder = new AuditRecorder(bus, store)
    recorder.start()

    await bus.publish(event)
    await bus.publish({ ...event, eventId: 'event-2', runId: 'run-2' })

    const reloaded = new FileAuditStore(directory)
    expect(await reloaded.listByRun('run-1')).toHaveLength(1)
    expect(await reloaded.list()).toHaveLength(2)
    expect(await readFile(join(directory, 'audit.jsonl'), 'utf8')).toContain('"eventType":"permission.requested"')
    recorder.stop()
  })
})

describe('audit query and export', () => {
  test('filters a timeline by run, event type, time range and limit', async () => {
    const store = new InMemoryAuditStore()
    await store.append(record('run-1', 'run.queued', '2026-08-24T00:00:00.000Z'))
    await store.append(record('run-1', 'run.completed', '2026-08-24T00:00:02.000Z'))
    await store.append(record('run-2', 'run.failed', '2026-08-24T00:00:03.000Z'))

    const result = await store.query({
      runId: 'run-1',
      eventTypes: ['run.completed'],
      from: '2026-08-24T00:00:01.000Z',
      to: '2026-08-24T00:00:03.000Z',
      limit: 1,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.eventType).toBe('run.completed')
  })

  test('exports filtered audit records as JSONL', async () => {
    const store = new InMemoryAuditStore()
    await store.append(record('run-1', 'run.queued', '2026-08-24T00:00:00.000Z'))
    await store.append(record('run-2', 'run.failed', '2026-08-24T00:00:01.000Z'))

    const lines = await exportAuditJsonl(store, { runId: 'run-2' })

    expect(lines.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(lines).runId).toBe('run-2')
  })

  test('queries child traces by parent run id', async () => {
    const store = new InMemoryAuditStore()
    await store.append({
      auditId: 'child-start',
      version: 1,
      recordedAt: '2026-08-24T00:00:00.000Z',
      eventType: 'delegation.started',
      runId: 'child-1',
      event: {
        type: 'delegation.started',
        eventId: 'child-start',
        runId: 'child-1',
        occurredAt: '2026-08-24T00:00:00.000Z',
        parentRunId: 'parent-1',
        childRunId: 'child-1',
        taskId: 'task-1',
      },
    })

    expect(await store.query({ parentRunId: 'parent-1' })).toHaveLength(1)
    expect(await store.query({ parentRunId: 'other-parent' })).toHaveLength(0)
  })
})

function record(runId: string, eventType: 'run.queued' | 'run.completed' | 'run.failed', occurredAt: string) {
  return {
    auditId: `${runId}-${eventType}`,
    version: 1 as const,
    recordedAt: occurredAt,
    eventType,
    runId,
    event: {
      eventId: `${runId}-${eventType}`,
      runId,
      occurredAt,
      type: eventType,
      ...(eventType === 'run.failed' ? { error: 'failed', run: { runId } } : {}),
      ...(eventType !== 'run.failed' ? { run: { runId } } : {}),
    },
  } as never
}
