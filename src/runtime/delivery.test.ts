import { describe, expect, test } from 'bun:test'

import { RuntimeEventBus, type RuntimeEvent } from './events.ts'
import { DeliveryRouter, InMemoryDeliveryAdapter } from './delivery.ts'

const event: RuntimeEvent = {
  eventId: 'event-1',
  runId: 'run-1',
  occurredAt: '2026-08-24T09:00:00.000Z',
  type: 'run.completed',
  run: {
    runId: 'run-1',
    botId: 'bot-1',
    sessionKey: 'bot-1:session-1',
    trigger: 'message',
    status: 'completed',
    attempt: 1,
    createdAt: '2026-08-24T09:00:00.000Z',
    updatedAt: '2026-08-24T09:00:00.000Z',
  },
  output: 'done',
}

describe('DeliveryRouter', () => {
  test('routes a normalized event and emits delivery lifecycle events', async () => {
    const bus = new RuntimeEventBus()
    const observed: RuntimeEvent[] = []
    bus.subscribe((runtimeEvent) => observed.push(runtimeEvent))
    const adapter = new InMemoryDeliveryAdapter('memory:')
    const router = new DeliveryRouter({ eventBus: bus, adapters: [adapter] })

    const result = await router.deliver('memory:inbox', event)

    expect(result).toMatchObject({ status: 'sent', target: 'memory:inbox' })
    expect(adapter.messages).toHaveLength(1)
    expect(adapter.messages[0]).toMatchObject({ target: 'memory:inbox', event })
    expect(observed.map((item) => item.type)).toEqual(['delivery.queued', 'delivery.sent'])
  })

  test('fails closed when no adapter handles the target', async () => {
    const bus = new RuntimeEventBus()
    const observed: RuntimeEvent[] = []
    bus.subscribe((runtimeEvent) => observed.push(runtimeEvent))
    const router = new DeliveryRouter({ eventBus: bus, adapters: [] })

    const result = await router.deliver('telegram:chat-1', event)

    expect(result).toMatchObject({ status: 'failed', target: 'telegram:chat-1' })
    expect(result.error).toContain('no delivery adapter')
    expect(observed.map((item) => item.type)).toEqual(['delivery.queued', 'delivery.failed'])
  })
})
