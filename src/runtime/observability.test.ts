import { describe, expect, test } from 'bun:test'

import { RuntimeEventBus } from './events.ts'
import { RuntimeMetricsCollector } from './observability.ts'

describe('RuntimeMetricsCollector', () => {
  test('aggregates run lifecycle, tool, delivery and latency metrics', async () => {
    const bus = new RuntimeEventBus()
    const metrics = new RuntimeMetricsCollector(bus)
    metrics.start()

    await bus.publish({
      type: 'run.started',
      eventId: 'start',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:00.000Z',
      run: { runId: 'run-1' } as never,
    })
    await bus.publish({
      type: 'assistant.delta',
      eventId: 'delta',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:01.000Z',
      text: 'hello',
    })
    await bus.publish({
      type: 'tool.started',
      eventId: 'tool',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:01.000Z',
      toolName: 'Read',
    })
    await bus.publish({
      type: 'run.completed',
      eventId: 'complete',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:02.500Z',
      run: { runId: 'run-1' } as never,
    })
    await bus.publish({
      type: 'delivery.failed',
      eventId: 'delivery',
      runId: 'run-1',
      occurredAt: '2026-08-24T00:00:03.000Z',
      target: 'telegram:chat-1',
      error: 'offline',
    })

    expect(metrics.snapshot()).toMatchObject({
      totalEvents: 5,
      runsStarted: 1,
      runsCompleted: 1,
      assistantDeltas: 1,
      toolsStarted: 1,
      deliveryFailures: 1,
      completedRunLatencyMs: 2500,
    })
    metrics.stop()
  })
})
