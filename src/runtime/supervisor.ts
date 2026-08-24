import type { RuntimeEventBus } from './events.ts'
import { SessionRegistry } from './sessions.ts'
import type { RunEnvelope, RunRequest, SessionRecord } from './types.ts'

export interface RunHandlerContext {
  run: RunEnvelope
  session: SessionRecord
  signal: AbortSignal
  publish: RuntimeEventBus['publish']
}

export interface RunHandlerResult {
  output?: string
  costUSD?: number
}

export interface RunResult extends RunHandlerResult {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export type RunHandler = (context: RunHandlerContext) => Promise<RunHandlerResult>

export interface RunSupervisorOptions {
  registry: SessionRegistry
  events?: RuntimeEventBus
  maxConcurrency?: number
  timeoutMs?: number
  maxAttempts?: number
  retryDelayMs?: number
  shouldRetry?: (error: unknown) => boolean
  maxConcurrencyPerBot?: number
  maxConcurrencyPerUser?: number
}

interface QueuedRun {
  run: RunEnvelope
  handler: RunHandler
  controller: AbortController
  resolve: (result: RunResult) => void
}

export class RunSupervisor {
  private readonly events?: RuntimeEventBus
  private readonly maxConcurrency: number
  private readonly queue: QueuedRun[] = []
  private readonly runs = new Map<string, RunEnvelope>()
  private readonly pending = new Map<string, Promise<RunResult>>()
  private readonly activeSessions = new Set<string>()
  private readonly activeRuns = new Map<string, QueuedRun>()
  private readonly activeBotCounts = new Map<string, number>()
  private readonly activeUserCounts = new Map<string, number>()
  private activeCount = 0
  private draining = false

  constructor(private readonly options: RunSupervisorOptions) {
    this.events = options.events
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 1)
  }

  submit(request: RunRequest, handler: RunHandler): Promise<RunResult> {
    const existing = request.idempotencyKey
      ? [...this.pending.entries()].find(([key]) => key === request.idempotencyKey)?.[1]
      : undefined
    if (existing) return existing

    const now = new Date().toISOString()
    const run: RunEnvelope = {
      runId: crypto.randomUUID(),
      botId: request.botId,
      sessionKey: request.sessionKey,
      trigger: request.trigger,
      status: 'queued',
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.source ? { source: request.source } : {}),
      ...(request.parentRunId ? { parentRunId: request.parentRunId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.workspace ? { workspace: request.workspace } : {}),
      ...(request.policyProfile ? { policyProfile: request.policyProfile } : {}),
      ...(request.budgetUSD !== undefined ? { budgetUSD: request.budgetUSD } : {}),
    }

    let resolve!: (result: RunResult) => void
    const promise = new Promise<RunResult>((resolvePromise) => {
      resolve = resolvePromise
    })
    this.runs.set(run.runId, run)
    this.queue.push({ run, handler, controller: new AbortController(), resolve })
    if (request.idempotencyKey) this.pending.set(request.idempotencyKey, promise)
    void this.emit({
      type: 'run.queued',
      eventId: crypto.randomUUID(),
      runId: run.runId,
      occurredAt: now,
      run: { ...run },
    })
    this.drain()
    return promise
  }

  cancel(runId: string): boolean {
    const queuedIndex = this.queue.findIndex((item) => item.run.runId === runId)
    if (queuedIndex >= 0) {
      const [item] = this.queue.splice(queuedIndex, 1)
      if (!item) return false
      this.finishCancelled(item, 'requested')
      return true
    }
    const run = this.runs.get(runId)
    const active = this.activeRuns.get(runId)
    if (!run || run.status !== 'running' || !active) return false
    active.controller.abort('requested')
    return true
  }

  getRun(runId: string): RunEnvelope | undefined {
    const run = this.runs.get(runId)
    return run ? { ...run } : undefined
  }

  listRuns(): RunEnvelope[] {
    return [...this.runs.values()].map((run) => ({ ...run }))
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    for (const item of [...this.queue]) this.cancel(item.run.runId)
    for (const item of this.activeRuns.values()) item.controller.abort(reason)
    await Promise.allSettled(this.pending.values())
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    try {
      let nextIndex = this.findRunnableIndex()
      while (this.activeCount < this.maxConcurrency && nextIndex >= 0) {
        const [item] = this.queue.splice(nextIndex, 1)
        if (item) {
          this.activeCount += 1
          this.activeSessions.add(item.run.sessionKey)
          this.incrementCount(this.activeBotCounts, item.run.botId)
          if (item.run.userId) this.incrementCount(this.activeUserCounts, item.run.userId)
          void this.execute(item).finally(() => {
            this.activeCount -= 1
            this.activeSessions.delete(item.run.sessionKey)
            this.decrementCount(this.activeBotCounts, item.run.botId)
            if (item.run.userId) this.decrementCount(this.activeUserCounts, item.run.userId)
            this.drain()
          })
        }
        nextIndex = this.findRunnableIndex()
      }
    } finally {
      this.draining = false
    }
  }

  private findRunnableIndex(): number {
    if (this.activeCount >= this.maxConcurrency) return -1
    return this.queue.findIndex((item) => {
      const botCount = this.activeBotCounts.get(item.run.botId) ?? 0
      const userCount = item.run.userId ? this.activeUserCounts.get(item.run.userId) ?? 0 : 0
      return (
        !this.activeSessions.has(item.run.sessionKey) &&
        botCount < (this.options.maxConcurrencyPerBot ?? Number.POSITIVE_INFINITY) &&
        userCount < (this.options.maxConcurrencyPerUser ?? Number.POSITIVE_INFINITY)
      )
    })
  }

  private async execute(item: QueuedRun): Promise<void> {
    const { run, controller } = item
    const session = await this.options.registry.getOrCreate({
      sessionKey: run.sessionKey,
      botId: run.botId,
      status: 'active',
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      ...(run.workspace ? { workspace: run.workspace } : {}),
    })
    run.status = 'running'
    run.attempt = 0
    run.updatedAt = new Date().toISOString()
    this.activeRuns.set(run.runId, item)
    try {
      while (run.attempt < Math.max(1, this.options.maxAttempts ?? 1)) {
        run.attempt += 1
        run.updatedAt = new Date().toISOString()
        await this.emit({
          type: 'run.started',
          eventId: crypto.randomUUID(),
          runId: run.runId,
          occurredAt: run.updatedAt,
          run: { ...run },
        })

        const attemptController = new AbortController()
        const abortAttempt = () => attemptController.abort(controller.signal.reason)
        controller.signal.addEventListener('abort', abortAttempt, { once: true })
        const timeout = this.options.timeoutMs
          ? setTimeout(() => attemptController.abort('timeout'), this.options.timeoutMs)
          : undefined
        try {
          const result = await this.options.registry.withLock(run.sessionKey, () =>
            item.handler({
              run: { ...run },
              session,
              signal: attemptController.signal,
              publish: this.publish,
            }),
          )
          if (controller.signal.aborted || attemptController.signal.aborted) {
            this.finishCancelled(item, controller.signal.reason === 'timeout' ? 'timeout' : 'requested')
            return
          }
          if (run.budgetUSD !== undefined && result.costUSD !== undefined && result.costUSD > run.budgetUSD) {
            const message = 'run budget exceeded'
            run.status = 'failed'
            run.error = message
            run.updatedAt = new Date().toISOString()
            await this.emit({
              type: 'run.failed',
              eventId: crypto.randomUUID(),
              runId: run.runId,
              occurredAt: run.updatedAt,
              run: { ...run },
              error: message,
            })
            item.resolve({ runId: run.runId, status: 'failed', error: message, ...result })
            return
          }
          run.status = 'completed'
          run.updatedAt = new Date().toISOString()
          await this.emit({
            type: 'run.completed',
            eventId: crypto.randomUUID(),
            runId: run.runId,
            occurredAt: run.updatedAt,
            run: { ...run },
            ...(result.output !== undefined ? { output: result.output } : {}),
          })
          item.resolve({ runId: run.runId, status: 'completed', ...result })
          return
        } catch (error) {
          if (controller.signal.aborted) {
            this.finishCancelled(item, controller.signal.reason === 'timeout' ? 'timeout' : 'requested')
            return
          }
          const timedOut = attemptController.signal.aborted
          const retryable = !timedOut && (this.options.shouldRetry?.(error) ?? false)
          if (!retryable || run.attempt >= Math.max(1, this.options.maxAttempts ?? 1)) {
            const message = timedOut ? 'run timed out' : error instanceof Error ? error.message : String(error)
            run.status = 'failed'
            run.error = message
            run.updatedAt = new Date().toISOString()
            await this.emit({
              type: 'run.failed',
              eventId: crypto.randomUUID(),
              runId: run.runId,
              occurredAt: run.updatedAt,
              run: { ...run },
              error: message,
            })
            item.resolve({ runId: run.runId, status: 'failed', error: message })
            return
          }
          if (this.options.retryDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, this.options.retryDelayMs))
          }
        } finally {
          if (timeout) clearTimeout(timeout)
          controller.signal.removeEventListener('abort', abortAttempt)
        }
      }
    } finally {
      this.activeRuns.delete(run.runId)
    }
  }

  private finishCancelled(item: QueuedRun, reason: string): void {
    item.run.status = 'cancelled'
    item.run.updatedAt = new Date().toISOString()
    item.controller.abort(reason)
    void this.emit({
      type: 'run.cancelled',
      eventId: crypto.randomUUID(),
      runId: item.run.runId,
      occurredAt: item.run.updatedAt,
      reason,
    })
    item.resolve({ runId: item.run.runId, status: 'cancelled' })
  }

  private publish = (event: Parameters<RuntimeEventBus['publish']>[0]): Promise<void> =>
    this.emit(event)

  private async emit(event: Parameters<RuntimeEventBus['publish']>[0]): Promise<void> {
    await this.events?.publish(event)
  }

  private incrementCount(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  private decrementCount(counts: Map<string, number>, key: string): void {
    const next = (counts.get(key) ?? 1) - 1
    if (next <= 0) counts.delete(key)
    else counts.set(key, next)
  }
}
