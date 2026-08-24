import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RuntimeEventBus, type RuntimeEvent } from './events.ts'
import { AuditRecorder, FileAuditStore, InMemoryAuditStore } from './audit.ts'

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
