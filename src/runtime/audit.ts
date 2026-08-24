import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RuntimeEvent, RuntimeEventBus } from './events.ts'

export interface AuditRecord {
  auditId: string
  version: 1
  recordedAt: string
  eventType: RuntimeEvent['type']
  runId: string
  event: RuntimeEvent
}

export interface AuditStore {
  append(record: AuditRecord): Promise<void>
  list(): Promise<AuditRecord[]>
  listByRun(runId: string): Promise<AuditRecord[]>
}

export class InMemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = []

  async append(record: AuditRecord): Promise<void> {
    this.records.push(record)
  }

  async list(): Promise<AuditRecord[]> {
    return this.records.map(cloneRecord)
  }

  async listByRun(runId: string): Promise<AuditRecord[]> {
    return (await this.list()).filter((record) => record.runId === runId)
  }
}

export class FileAuditStore implements AuditStore {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly directory: string, private readonly fileName = 'audit.jsonl') {}

  append(record: AuditRecord): Promise<void> {
    const operation = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true })
      await writeFile(join(this.directory, this.fileName), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    })
    this.pending = operation.catch(() => undefined)
    return operation
  }

  async list(): Promise<AuditRecord[]> {
    let content: string
    try {
      content = await readFile(join(this.directory, this.fileName), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AuditRecord)
  }

  async listByRun(runId: string): Promise<AuditRecord[]> {
    return (await this.list()).filter((record) => record.runId === runId)
  }
}

export class AuditRecorder {
  private unsubscribe?: () => boolean

  constructor(
    private readonly eventBus: RuntimeEventBus,
    private readonly store: AuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.eventBus.subscribe((event) => this.store.append(toAuditRecord(event, this.now())))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }
}

function toAuditRecord(event: RuntimeEvent, now: Date): AuditRecord {
  return {
    auditId: crypto.randomUUID(),
    version: 1,
    recordedAt: now.toISOString(),
    eventType: event.type,
    runId: event.runId,
    event: sanitize(event) as RuntimeEvent,
  }
}

function sanitize(value: unknown, key?: string, seen = new WeakSet<object>()): unknown {
  if (key && isSensitiveKey(key)) return '[REDACTED]'
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitize(item, undefined, seen))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, sanitize(entryValue, entryKey, seen)]),
  )
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|credential|private[_-]?key|api[_-]?key|access[_-]?key/i.test(key)
}

function cloneRecord(record: AuditRecord): AuditRecord {
  return JSON.parse(JSON.stringify(record)) as AuditRecord
}
