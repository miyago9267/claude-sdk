import { randomUUID } from 'node:crypto'

import { RuntimeEventBus, type RuntimeEvent } from './events.ts'

export interface DeliveryRequest {
  target: string
  event: RuntimeEvent
}

export interface DeliveryAdapterResult {
  externalId?: string
}

export interface DeliveryAdapter {
  canHandle(target: string): boolean
  deliver(request: DeliveryRequest): Promise<DeliveryAdapterResult>
}

export type DeliveryResult =
  | { status: 'sent'; target: string; externalId?: string }
  | { status: 'failed'; target: string; error: string }

export interface DeliveryRouterOptions {
  adapters?: DeliveryAdapter[]
  eventBus?: RuntimeEventBus
  now?: () => Date
}

export class DeliveryRouter {
  private readonly adapters: DeliveryAdapter[]
  private readonly eventBus: RuntimeEventBus
  private readonly now: () => Date

  constructor(options: DeliveryRouterOptions = {}) {
    this.adapters = options.adapters ?? []
    this.eventBus = options.eventBus ?? new RuntimeEventBus()
    this.now = options.now ?? (() => new Date())
  }

  async deliver(target: string, event: RuntimeEvent): Promise<DeliveryResult> {
    await this.publish({
      type: 'delivery.queued',
      target,
      runId: event.runId,
    })

    const adapter = this.adapters.find((candidate) => candidate.canHandle(target))
    if (!adapter) {
      const error = `no delivery adapter for target: ${target}`
      await this.publish({ type: 'delivery.failed', target, runId: event.runId, error })
      return { status: 'failed', target, error }
    }

    try {
      const result = await adapter.deliver({ target, event })
      await this.publish({ type: 'delivery.sent', target, runId: event.runId })
      return { status: 'sent', target, ...(result.externalId ? { externalId: result.externalId } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.publish({ type: 'delivery.failed', target, runId: event.runId, error: message })
      return { status: 'failed', target, error: message }
    }
  }

  private publish(input: { type: 'delivery.queued' | 'delivery.sent' | 'delivery.failed'; target: string; runId: string; error?: string }): Promise<void> {
    const base = {
      eventId: randomUUID(),
      runId: input.runId,
      occurredAt: this.now().toISOString(),
      type: input.type,
      target: input.target,
    }
    return this.eventBus.publish(
      input.type === 'delivery.failed'
        ? { ...base, type: input.type, error: input.error ?? 'delivery failed' }
        : base,
    )
  }
}

export class InMemoryDeliveryAdapter implements DeliveryAdapter {
  readonly messages: DeliveryRequest[] = []

  constructor(private readonly prefix: string) {}

  canHandle(target: string): boolean {
    return target.startsWith(this.prefix)
  }

  async deliver(request: DeliveryRequest): Promise<DeliveryAdapterResult> {
    this.messages.push(request)
    return { externalId: `${request.target}:${this.messages.length}` }
  }
}
