import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface MemoryScope {
  botId: string
  userId?: string
  workspace?: string
  sessionKey?: string
}

export interface MemoryEntry {
  id: string
  scope: MemoryScope
  content: string
  tags?: string[]
  source?: string
  createdAt: string
  updatedAt: string
}

export interface MemoryHit extends MemoryEntry {
  score: number
}

export interface MemoryProvider {
  search(query: string, scope: MemoryScope): Promise<MemoryHit[]>
  write(entry: MemoryEntry): Promise<void>
  forget(id: string, scope: MemoryScope): Promise<void>
}

const scopeKey = (scope: MemoryScope): string =>
  JSON.stringify({
    botId: scope.botId,
    userId: scope.userId ?? null,
    workspace: scope.workspace ?? null,
    sessionKey: scope.sessionKey ?? null,
  })

const sameScope = (left: MemoryScope, right: MemoryScope): boolean => scopeKey(left) === scopeKey(right)

const scoreEntry = (entry: MemoryEntry, query: string): number => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = `${entry.content} ${(entry.tags ?? []).join(' ')}`.toLowerCase()
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0)
}

export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly entries = new Map<string, MemoryEntry>()

  async search(query: string, scope: MemoryScope): Promise<MemoryHit[]> {
    return [...this.entries.values()]
      .filter((entry) => sameScope(entry.scope, scope))
      .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
  }

  async write(entry: MemoryEntry): Promise<void> {
    if (!entry.content.trim()) throw new Error('memory content must not be empty')
    this.entries.set(`${scopeKey(entry.scope)}:${entry.id}`, entry)
  }

  async forget(id: string, scope: MemoryScope): Promise<void> {
    this.entries.delete(`${scopeKey(scope)}:${id}`)
  }
}

export class MarkdownMemoryProvider implements MemoryProvider {
  constructor(private readonly directory: string) {}

  async search(query: string, scope: MemoryScope): Promise<MemoryHit[]> {
    const entries = await this.readScope(scope)
    return entries
      .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
  }

  async write(entry: MemoryEntry): Promise<void> {
    if (!entry.content.trim()) throw new Error('memory content must not be empty')
    const entries = await this.readScope(entry.scope)
    const index = entries.findIndex((candidate) => candidate.id === entry.id)
    if (index >= 0) entries[index] = entry
    else entries.push(entry)
    await this.writeScope(entry.scope, entries)
  }

  async forget(id: string, scope: MemoryScope): Promise<void> {
    const entries = (await this.readScope(scope)).filter((entry) => entry.id !== id)
    if (entries.length === 0) {
      try {
        await unlink(this.pathFor(scope))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return
    }
    await this.writeScope(scope, entries)
  }

  private async readScope(scope: MemoryScope): Promise<MemoryEntry[]> {
    let content: string
    try {
      content = await readFile(this.pathFor(scope), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: MemoryEntry[] = []
    const pattern = /<!-- memory:([^\s]+) -->\n([\s\S]*?)\n<!-- \/memory:\1 -->/g
    for (const match of content.matchAll(pattern)) {
      try {
        const parsed = JSON.parse(match[2] ?? '') as MemoryEntry
        if (parsed.id === match[1] && sameScope(parsed.scope, scope)) entries.push(parsed)
      } catch {
        continue
      }
    }
    return entries
  }

  private async writeScope(scope: MemoryScope, entries: MemoryEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const content = entries
      .map(
        (entry) =>
          `<!-- memory:${entry.id} -->\n${JSON.stringify(entry)}\n<!-- /memory:${entry.id} -->`,
      )
      .join('\n\n')
    const path = this.pathFor(scope)
    const temporaryPath = `${path}.${process.pid}.tmp`
    await writeFile(temporaryPath, `${content}\n`, 'utf8')
    await rename(temporaryPath, path)
  }

  private pathFor(scope: MemoryScope): string {
    const digest = createHash('sha256').update(scopeKey(scope)).digest('hex')
    return join(this.directory, `${digest}.md`)
  }
}
