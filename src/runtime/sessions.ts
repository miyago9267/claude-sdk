import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SessionRecord } from './types.ts'

export interface SessionStore {
  get(sessionKey: string): Promise<SessionRecord | undefined>
  save(record: SessionRecord): Promise<void>
  delete(sessionKey: string): Promise<void>
  list(): Promise<Array<{ path?: string; record: SessionRecord }>>
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>()

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.records.get(sessionKey)
  }

  async save(record: SessionRecord): Promise<void> {
    this.records.set(record.sessionKey, record)
  }

  async delete(sessionKey: string): Promise<void> {
    this.records.delete(sessionKey)
  }

  async list(): Promise<Array<{ record: SessionRecord }>> {
    return [...this.records.values()].map((record) => ({ record }))
  }
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly directory: string) {}

  async get(sessionKey: string): Promise<SessionRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.pathFor(sessionKey), 'utf8')) as SessionRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async save(record: SessionRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const path = this.pathFor(record.sessionKey)
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  async delete(sessionKey: string): Promise<void> {
    const path = this.pathFor(sessionKey)
    try {
      await unlink(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async list(): Promise<Array<{ path: string; record: SessionRecord }>> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: Array<{ path: string; record: SessionRecord }> = []
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      const path = join(this.directory, name)
      records.push({ path, record: JSON.parse(await readFile(path, 'utf8')) as SessionRecord })
    }
    return records
  }

  private pathFor(sessionKey: string): string {
    const digest = createHash('sha256').update(sessionKey).digest('hex')
    return join(this.directory, `${digest}.json`)
  }
}

export class SessionRegistry {
  private readonly locks = new Map<string, Promise<void>>()

  constructor(private readonly store: SessionStore) {}

  get(sessionKey: string): Promise<SessionRecord | undefined> {
    return this.store.get(sessionKey)
  }

  async getOrCreate(record: SessionRecord): Promise<SessionRecord> {
    return this.withLock(record.sessionKey, async () => {
      const existing = await this.store.get(record.sessionKey)
      if (existing) return existing
      await this.store.save(record)
      return record
    })
  }

  async update(
    sessionKey: string,
    patch: Partial<Omit<SessionRecord, 'sessionKey' | 'createdAt'>>,
  ): Promise<SessionRecord | undefined> {
    const existing = await this.store.get(sessionKey)
    if (!existing) return undefined
    const updated = { ...existing, ...patch, sessionKey, updatedAt: new Date().toISOString() }
    await this.store.save(updated)
    return updated
  }

  async withLock<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const lock = previous.then(() => current)
    this.locks.set(sessionKey, lock)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(sessionKey) === lock) this.locks.delete(sessionKey)
    }
  }
}
