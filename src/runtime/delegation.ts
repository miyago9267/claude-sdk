import { randomUUID } from 'node:crypto'

import type { BotRuntime, BotRuntimeRequest, BotRunHandle } from './bot-runtime.ts'
import { RuntimeEventBus, type RuntimeEvent } from './events.ts'
import type { RunResult } from './supervisor.ts'

export interface DelegationRequest extends Omit<BotRuntimeRequest, 'sessionKey' | 'trigger' | 'parentRunId'> {
  taskId: string
  parentRunId: string
  sessionKey?: string
  trigger?: BotRuntimeRequest['trigger']
  timeoutMs?: number
}
export interface DelegationHandle {
  taskId: string
  parentRunId: string
  childRunId: string
  result: Promise<RunResult>
  cancel(): boolean
}

export interface DelegationAggregate {
  parentRunId: string
  results: RunResult[]
  completed: number
  failed: number
  partialFailure: boolean
}

export interface DelegationManagerOptions {
  runtime: BotRuntime
  events?: RuntimeEventBus
}

export class DelegationManager {
  private readonly runtime: BotRuntime
  private readonly events?: RuntimeEventBus

  constructor(options: DelegationManagerOptions) {
    this.runtime = options.runtime
    this.events = options.events
  }

  start(request: DelegationRequest): DelegationHandle {
    const childRequest: BotRuntimeRequest = {
      ...request,
      trigger: request.trigger ?? 'job',
      sessionKey: request.sessionKey ?? `${request.parentRunId}:child:${request.taskId}`,
      idempotencyKey: request.idempotencyKey ?? `delegation:${request.parentRunId}:${request.taskId}`,
      parentRunId: request.parentRunId,
    }
    const child = this.runtime.start(childRequest)
    void this.emit({
      type: 'delegation.requested',
      parentRunId: request.parentRunId,
      childRunId: child.runId,
      taskId: request.taskId,
    })
    void this.emit({
      type: 'delegation.started',
      parentRunId: request.parentRunId,
      childRunId: child.runId,
      taskId: request.taskId,
    })

    let timedOut = false
    const timeout = request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true
          child.cancel()
        }, request.timeoutMs)
    const result = child.result.then(async (childResult) => {
      if (timeout) clearTimeout(timeout)
      const result = timedOut && childResult.status === 'cancelled'
        ? { ...childResult, error: 'delegation timed out' }
        : childResult
      await this.emit({
        type: result.status === 'completed' ? 'delegation.completed' : 'delegation.failed',
        parentRunId: request.parentRunId,
        childRunId: child.runId,
        taskId: request.taskId,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
      })
      return result
    })

    return {
      taskId: request.taskId,
      parentRunId: request.parentRunId,
      childRunId: child.runId,
      result,
      cancel: () => child.cancel(),
    }
  }

  delegate(request: DelegationRequest): Promise<RunResult> {
    return this.start(request).result
  }

  async delegateMany(parentRunId: string, requests: DelegationRequest[]): Promise<DelegationAggregate> {
    const handles = requests.map((request) => this.start({ ...request, parentRunId }))
    const results = await Promise.all(handles.map((handle) => handle.result))
    const completed = results.filter((result) => result.status === 'completed').length
    const failed = results.length - completed
    return {
      parentRunId,
      results,
      completed,
      failed,
      partialFailure: completed > 0 && failed > 0,
    }
  }

  private async emit(input: {
    type: Extract<RuntimeEvent['type'], `delegation.${string}`>
    parentRunId: string
    childRunId: string
    taskId: string
    output?: string
    error?: string
  }): Promise<void> {
    if (!this.events) return
    const base = {
      eventId: randomUUID(),
      runId: input.childRunId,
      occurredAt: new Date().toISOString(),
      parentRunId: input.parentRunId,
      childRunId: input.childRunId,
      taskId: input.taskId,
    }
    if (input.type === 'delegation.requested' || input.type === 'delegation.started') {
      await this.events.publish({ ...base, type: input.type })
    } else if (input.type === 'delegation.completed') {
      await this.events.publish({ ...base, type: input.type, ...(input.output !== undefined ? { output: input.output } : {}) })
    } else {
      await this.events.publish({ ...base, type: input.type, error: input.error ?? 'delegation failed' })
    }
  }
}
