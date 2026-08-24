import type { RunEnvelope } from './types.ts'

export interface RuntimeEventBase {
  eventId: string
  runId: string
  occurredAt: string
}

export type RuntimeEvent =
  | (RuntimeEventBase & { type: 'run.queued'; run: RunEnvelope })
  | (RuntimeEventBase & { type: 'run.started'; run: RunEnvelope })
  | (RuntimeEventBase & { type: 'run.completed'; run: RunEnvelope; output?: string })
  | (RuntimeEventBase & { type: 'run.failed'; run: RunEnvelope; error: string })
  | (RuntimeEventBase & { type: 'run.cancelled'; reason: string })
  | (RuntimeEventBase & { type: 'assistant.delta'; text: string })
  | (RuntimeEventBase & { type: 'tool.started'; toolName: string })
  | (RuntimeEventBase & { type: 'tool.progress'; toolName: string; detail?: string })
  | (RuntimeEventBase & { type: 'tool.completed'; toolName: string; error?: string })
  | (RuntimeEventBase & { type: 'permission.requested'; toolName: string; input?: unknown })
  | (RuntimeEventBase & { type: 'approval.received'; decision: string })
  | (RuntimeEventBase & { type: 'delivery.queued'; target: string })
  | (RuntimeEventBase & { type: 'delivery.sent'; target: string })
  | (RuntimeEventBase & { type: 'delivery.failed'; target: string; error: string })

export type RuntimeEventSubscriber = (event: RuntimeEvent) => void | Promise<void>

export class RuntimeEventBus {
  private readonly subscribers = new Set<RuntimeEventSubscriber>()

  subscribe(subscriber: RuntimeEventSubscriber): () => void {
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  async publish(event: RuntimeEvent): Promise<void> {
    for (const subscriber of this.subscribers) await subscriber(event)
  }
}
