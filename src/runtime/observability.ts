import type { RuntimeEvent, RuntimeEventBus } from './events.ts'

export interface RuntimeMetricsSnapshot {
  totalEvents: number
  runsStarted: number
  runsCompleted: number
  runsFailed: number
  runsCancelled: number
  runsAbandoned: number
  assistantDeltas: number
  toolsStarted: number
  deliveryFailures: number
  completedRunLatencyMs: number
}

export class RuntimeMetricsCollector {
  private unsubscribe?: () => boolean
  private readonly startedAt = new Map<string, number>()
  private metrics: RuntimeMetricsSnapshot = emptySnapshot()

  constructor(private readonly eventBus: RuntimeEventBus) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.eventBus.subscribe((event) => this.record(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  snapshot(): RuntimeMetricsSnapshot {
    return { ...this.metrics }
  }

  reset(): void {
    this.metrics = emptySnapshot()
    this.startedAt.clear()
  }

  private record(event: RuntimeEvent): void {
    this.metrics.totalEvents += 1
    switch (event.type) {
      case 'run.started':
        this.metrics.runsStarted += 1
        this.startedAt.set(event.runId, Date.parse(event.occurredAt))
        break
      case 'run.completed':
        this.metrics.runsCompleted += 1
        this.recordLatency(event.runId, event.occurredAt)
        break
      case 'run.failed':
        this.metrics.runsFailed += 1
        break
      case 'run.cancelled':
        this.metrics.runsCancelled += 1
        break
      case 'run.abandoned':
        this.metrics.runsAbandoned += 1
        break
      case 'assistant.delta':
        this.metrics.assistantDeltas += 1
        break
      case 'tool.started':
        this.metrics.toolsStarted += 1
        break
      case 'delivery.failed':
        this.metrics.deliveryFailures += 1
        break
    }
  }

  private recordLatency(runId: string, occurredAt: string): void {
    const started = this.startedAt.get(runId)
    if (started === undefined) return
    this.metrics.completedRunLatencyMs += Math.max(0, Date.parse(occurredAt) - started)
    this.startedAt.delete(runId)
  }
}

function emptySnapshot(): RuntimeMetricsSnapshot {
  return {
    totalEvents: 0,
    runsStarted: 0,
    runsCompleted: 0,
    runsFailed: 0,
    runsCancelled: 0,
    runsAbandoned: 0,
    assistantDeltas: 0,
    toolsStarted: 0,
    deliveryFailures: 0,
    completedRunLatencyMs: 0,
  }
}
