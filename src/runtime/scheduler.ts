import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCronExpression } from './cron.ts'
import type { RuntimeEvent } from './events.ts'
import type { DeliveryRouter } from './delivery.ts'
import type { BotRuntime } from './bot-runtime.ts'
import type { RunResult } from './supervisor.ts'
import type { RunHandler, RunSupervisor } from './supervisor.ts'
import type { RunEnvelope } from './types.ts'

export type JobSchedule =
  | { type: 'once'; at: string }
  | { type: 'interval'; everyMs: number }
  | { type: 'cron'; expression: string }
  | { type: 'heartbeat'; everyMs: number; activeHoursUtc?: HeartbeatHours }

export interface HeartbeatHours {
  startHour: number
  endHour: number
}

export type JobStatus = 'active' | 'paused' | 'completed' | 'failed'

export interface ScheduledJob {
  id: string
  botId: string
  sessionKey: string
  trigger: 'cron' | 'heartbeat' | 'job'
  schedule: JobSchedule
  status: JobStatus
  sessionMode?: 'isolated' | 'shared'
  nextRunAt?: string
  deliveryTarget?: string
  prompt?: string
  model?: string
  workspace?: string
  lastRunId?: string
  lastError?: string
  createdAt?: string
  updatedAt?: string
}

export interface ScheduledJobPatch {
  sessionKey?: string
  trigger?: ScheduledJob['trigger']
  schedule?: JobSchedule
  nextRunAt?: string | null
  prompt?: string
  deliveryTarget?: string
  model?: string
  workspace?: string
}

export interface JobStore {
  get(id: string): Promise<ScheduledJob | undefined>
  save(job: ScheduledJob): Promise<void>
  delete(id: string): Promise<void>
  list(): Promise<ScheduledJob[]>
}

export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, ScheduledJob>()

  async get(id: string): Promise<ScheduledJob | undefined> {
    return this.jobs.get(id)
  }

  async save(job: ScheduledJob): Promise<void> {
    this.jobs.set(job.id, job)
  }

  async delete(id: string): Promise<void> {
    this.jobs.delete(id)
  }

  async list(): Promise<ScheduledJob[]> {
    return [...this.jobs.values()]
  }
}

export class FileJobStore implements JobStore {
  constructor(private readonly directory: string) {}

  async get(id: string): Promise<ScheduledJob | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(id), 'utf8')) as ScheduledJob
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(job: ScheduledJob): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = this.pathFor(job.id)
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.pathFor(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async list(): Promise<ScheduledJob[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return Promise.all(
      names.filter((name) => name.endsWith('.json')).map(async (name) => {
        return JSON.parse(await readFile(join(this.directory, name), 'utf8')) as ScheduledJob
      }),
    )
  }

  private pathFor(id: string): string {
    const digest = createHash('sha256').update(id).digest('hex')
    return join(this.directory, `${digest}.json`)
  }
}

export interface SchedulerOptions {
  store: JobStore
  supervisor?: RunSupervisor
  handler?: (job: ScheduledJob) => RunHandler
  runtime?: BotRuntime
  now?: () => Date
  onTickError?: (error: unknown) => void | Promise<void>
  delivery?: DeliveryRouter
}

export class Scheduler {
  private readonly running = new Set<string>()
  private readonly now: () => Date
  private timer?: ReturnType<typeof setInterval>

  constructor(private readonly options: SchedulerOptions) {
    if (!options.runtime && (!options.supervisor || !options.handler)) {
      throw new Error('scheduler requires runtime or supervisor and handler')
    }
    this.now = options.now ?? (() => new Date())
  }

  async register(input: ScheduledJob): Promise<ScheduledJob> {
    const existing = await this.options.store.get(input.id)
    if (existing) throw new Error(`job already exists: ${input.id}`)
    const now = this.now().toISOString()
    const job: ScheduledJob = {
      ...input,
      ...(input.createdAt ? {} : { createdAt: now }),
      ...(input.updatedAt ? {} : { updatedAt: now }),
      ...(input.nextRunAt ? {} : { nextRunAt: nextRunAt(input, this.now()) }),
    }
    await this.options.store.save(job)
    return job
  }

  get(id: string): Promise<ScheduledJob | undefined> {
    return this.options.store.get(id)
  }

  list(): Promise<ScheduledJob[]> {
    return this.options.store.list()
  }

  async edit(id: string, patch: ScheduledJobPatch): Promise<ScheduledJob> {
    const job = await this.requireJob(id)
    const schedule = patch.schedule ?? job.schedule
    const scheduleChanged = patch.schedule !== undefined
    const updatedNextRunAt = patch.nextRunAt !== undefined
      ? patch.nextRunAt
      : scheduleChanged
        ? nextRunAt({ ...job, schedule }, this.now())
        : job.nextRunAt
    const updated: ScheduledJob = {
      ...job,
      ...patch,
      schedule,
      ...(updatedNextRunAt === undefined || updatedNextRunAt === null
        ? { nextRunAt: undefined }
        : { nextRunAt: updatedNextRunAt }),
      updatedAt: this.now().toISOString(),
    }
    await this.options.store.save(updated)
    return updated
  }

  async pause(id: string): Promise<ScheduledJob> {
    return this.updateStatus(id, 'paused')
  }

  async resume(id: string, at = this.now()): Promise<ScheduledJob> {
    const job = await this.requireJob(id)
    const updated = { ...job, status: 'active' as const, nextRunAt: at.toISOString(), updatedAt: at.toISOString() }
    await this.options.store.save(updated)
    return updated
  }

  async remove(id: string): Promise<void> {
    const job = await this.options.store.get(id)
    if (job?.lastRunId) {
      if (this.options.runtime) this.options.runtime.cancel(job.lastRunId)
      else this.options.supervisor?.cancel(job.lastRunId)
    }
    await this.options.store.delete(id)
  }

  async trigger(id: string): Promise<RunResult[]> {
    const job = await this.requireJob(id)
    if (job.status === 'paused') return []
    return this.executeJob(job, true)
  }

  async tick(at = this.now()): Promise<RunResult[]> {
    const due = (await this.options.store.list()).filter(
      (job) => job.status === 'active' && job.nextRunAt !== undefined && new Date(job.nextRunAt) <= at,
    )
    const results: RunResult[] = []
    for (const job of due) {
      if (job.schedule.type === 'heartbeat' && !heartbeatIsActive(job.schedule, at)) {
        await this.advanceHeartbeat(job, at)
        continue
      }
      results.push(...(await this.executeJob(job, false)))
    }
    return results
  }

  start(pollIntervalMs = 1_000): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        if (this.options.onTickError) void this.options.onTickError(error)
      })
    }, pollIntervalMs)
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  private async executeJob(job: ScheduledJob, manual: boolean): Promise<RunResult[]> {
    if (this.running.has(job.id)) return []
    this.running.add(job.id)
    const now = this.now()
    const next = manual ? job.nextRunAt : nextRunAt(job, now)
    const queued = {
      ...job,
      ...(next ? { nextRunAt: next } : {}),
      ...(job.schedule.type === 'once' && !manual ? { nextRunAt: undefined } : {}),
      updatedAt: now.toISOString(),
    }
    await this.options.store.save(queued)
    const result = this.options.runtime
      ? await this.runThroughRuntime(job, now)
      : await this.options.supervisor!.submit(
          {
            botId: job.botId,
            sessionKey: this.sessionKeyFor(job),
            trigger: job.trigger,
            idempotencyKey: `job:${job.id}:${now.toISOString()}`,
            ...(job.model ? { model: job.model } : {}),
            ...(job.workspace ? { workspace: job.workspace } : {}),
          },
          this.options.handler!(job),
        )
    this.running.delete(job.id)
    const deliveryResult = this.options.runtime ? undefined : await this.deliverResult(job, result)
    const finalJob = await this.options.store.get(job.id)
    if (!finalJob) return [result]
    const updated: ScheduledJob = {
      ...finalJob,
      lastRunId: result.runId,
      ...(result.error ? { lastError: result.error } : deliveryResult?.status === 'failed'
        ? { lastError: deliveryResult.error }
        : {}),
      status: job.schedule.type === 'once' && !manual
        ? result.status === 'completed' ? 'completed' : 'failed'
        : 'active',
      updatedAt: this.now().toISOString(),
    }
    await this.options.store.save(updated)
    return [result]
  }

  private async runThroughRuntime(job: ScheduledJob, now: Date): Promise<RunResult> {
    if (!job.prompt) throw new Error(`scheduled job requires prompt: ${job.id}`)
    return this.options.runtime!.run({
      botId: job.botId,
      sessionKey: this.sessionKeyFor(job),
      trigger: job.trigger,
      idempotencyKey: `job:${job.id}:${now.toISOString()}`,
      prompt: job.prompt,
      deliveryTarget: job.deliveryTarget,
      ...(job.model ? { model: job.model } : {}),
      ...(job.workspace ? { workspace: job.workspace } : {}),
    })
  }

  private async advanceHeartbeat(job: ScheduledJob, at: Date): Promise<void> {
    const current = await this.options.store.get(job.id)
    if (!current || current.status !== 'active') return
    await this.options.store.save({
      ...current,
      nextRunAt: nextRunAt(current, at),
      updatedAt: at.toISOString(),
    })
  }

  private sessionKeyFor(job: ScheduledJob): string {
    return job.sessionMode === 'shared' ? job.sessionKey : `${job.sessionKey}:job:${job.id}`
  }

  private async deliverResult(job: ScheduledJob, result: RunResult) {
    if (!job.deliveryTarget || !this.options.delivery) return undefined
    const run = this.options.supervisor?.getRun(result.runId)
    if (!run) return undefined
    const event = result.status === 'completed'
      ? makeCompletedEvent(run, result.output)
      : result.status === 'failed'
        ? makeFailedEvent(run, result.error ?? 'run failed')
        : makeCancelledEvent(run.runId, result.error ?? 'run cancelled')
    return this.options.delivery.deliver(job.deliveryTarget, event)
  }

  private async updateStatus(id: string, status: JobStatus): Promise<ScheduledJob> {
    const job = await this.requireJob(id)
    const updated = { ...job, status, updatedAt: this.now().toISOString() }
    await this.options.store.save(updated)
    return updated
  }

  private async requireJob(id: string): Promise<ScheduledJob> {
    const job = await this.options.store.get(id)
    if (!job) throw new Error(`job not found: ${id}`)
    return job
  }
}

function nextRunAt(job: ScheduledJob, now: Date): string | undefined {
  if (job.schedule.type === 'once') return job.schedule.at
  if (job.schedule.type === 'cron') return parseCronExpression(job.schedule.expression).nextAfter(now).toISOString()
  return new Date(now.getTime() + job.schedule.everyMs).toISOString()
}

function heartbeatIsActive(schedule: Extract<JobSchedule, { type: 'heartbeat' }>, at: Date): boolean {
  if (!schedule.activeHoursUtc) return true
  const { startHour, endHour } = schedule.activeHoursUtc
  const hour = at.getUTCHours()
  if (startHour === endHour) return true
  return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour
}

function makeCompletedEvent(run: RunEnvelope, output?: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId: run.runId,
    occurredAt: new Date().toISOString(),
    type: 'run.completed',
    run,
    ...(output !== undefined ? { output } : {}),
  }
}

function makeFailedEvent(run: RunEnvelope, error: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId: run.runId,
    occurredAt: new Date().toISOString(),
    type: 'run.failed',
    run,
    error,
  }
}

function makeCancelledEvent(runId: string, reason: string): RuntimeEvent {
  return {
    eventId: crypto.randomUUID(),
    runId,
    occurredAt: new Date().toISOString(),
    type: 'run.cancelled',
    reason,
  }
}
