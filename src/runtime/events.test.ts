import { describe, expect, test } from 'bun:test'

import { RuntimeEventBus, type RuntimeEvent } from './events.ts'

describe('RuntimeEventBus', () => {
  test('publishes events to subscribers and supports unsubscribe', async () => {
    const bus = new RuntimeEventBus()
    const received: RuntimeEvent[] = []
    const unsubscribe = bus.subscribe((event) => {
      received.push(event)
    })

    await bus.publish({
      type: 'run.queued',
      eventId: 'event-1',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:00.000Z',
      run: {
        runId: 'run-1',
        botId: 'bot-1',
        sessionKey: 'bot-1:user-1',
        trigger: 'message',
        status: 'queued',
        attempt: 0,
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
    })

    unsubscribe()
    expect(received).toHaveLength(1)
    expect(received[0]?.type).toBe('run.queued')
  })

  test('awaits asynchronous subscribers', async () => {
    const bus = new RuntimeEventBus()
    let completed = false
    bus.subscribe(async () => {
      await Promise.resolve()
      completed = true
    })

    await bus.publish({
      type: 'run.cancelled',
      eventId: 'event-2',
      runId: 'run-2',
      occurredAt: '2026-08-24T00:00:00.000Z',
      reason: 'requested',
    })

    expect(completed).toBe(true)
  })
})
