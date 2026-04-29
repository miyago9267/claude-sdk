/**
 * Local session persistence — phase A of session resume.
 *
 * Layout (~/.claude-sdk/sessions/):
 *   _index.json         — array of SessionMeta, lookup by id / latest-by-cwd
 *   <logical-id>.jsonl  — turn-per-line transcript:
 *                           {"role":"user","content":"...","ts":<unix>}
 *                           {"role":"assistant","content":"...","ts":<unix>}
 *
 * The "logical id" is ours (UUID v4) and persists across V2 sessions, so
 * resume can keep appending to the same jsonl even though the underlying
 * SDK session_id changes on every V2 spawn. Phase B will mirror this
 * into ~/.claude/projects/ for interop with the official CLI.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { OfficialResolver } from './official-session.ts'

export type Role = 'user' | 'assistant'

export interface Turn {
  role: Role
  content: string
  ts: number
}

export interface SessionMeta {
  id: string
  cwd: string
  model: string
  createdAt: number
  lastUsedAt: number
  turnCount: number
}

interface IndexFile {
  sessions: SessionMeta[]
}

export interface SessionStoreOptions {
  /** Override base dir, useful for tests. Default ~/.claude-sdk/sessions. */
  dir?: string
  /** Mirror writes to ~/.claude/projects/<encoded-cwd>/<id>.jsonl in the
   * official Claude Code schema so `claude -r <id>` can resume the same
   * conversation. Default: true. */
  mirror?: boolean
  /** Resolver to use when mirror=true. Override for tests. */
  official?: OfficialResolver
}

const INDEX_NAME = '_index.json'

export class SessionStore {
  private readonly dir: string
  private readonly mirror: boolean
  private readonly official: OfficialResolver

  constructor(opts: SessionStoreOptions = {}) {
    this.dir = opts.dir ?? defaultStoreDir()
    this.mirror = opts.mirror ?? true
    this.official = opts.official ?? new OfficialResolver()
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /** Create a fresh logical session and persist its initial metadata entry.
   * If `id` is provided, reuse it instead of generating a new UUID — used
   * when importing an existing official session so the same id chains both
   * local and official jsonl. */
  create(meta: { cwd: string; model: string; id?: string }): SessionMeta {
    const now = Math.floor(Date.now() / 1000)
    const entry: SessionMeta = {
      id: meta.id ?? randomUUID(),
      cwd: meta.cwd,
      model: meta.model,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
    }
    const idx = this.readIndex()
    if (!idx.sessions.find((s) => s.id === entry.id)) {
      idx.sessions.push(entry)
      this.writeIndex(idx)
    }
    if (!existsSync(this.jsonlPath(entry.id))) {
      writeFileSync(this.jsonlPath(entry.id), '')
    }
    return entry
  }

  /** Append one turn (atomic per-line) and bump metadata in the index. */
  appendTurn(id: string, turn: Omit<Turn, 'ts'> & { ts?: number }): void {
    const ts = turn.ts ?? Math.floor(Date.now() / 1000)
    const line = JSON.stringify({ role: turn.role, content: turn.content, ts }) + '\n'
    appendFileSync(this.jsonlPath(id), line)

    const idx = this.readIndex()
    const meta = idx.sessions.find((s) => s.id === id)
    if (meta) {
      meta.lastUsedAt = ts
      meta.turnCount += 1
      this.writeIndex(idx)
    }

    if (this.mirror && meta) {
      try {
        this.official.appendOfficialTurn({
          cwd: meta.cwd,
          sessionId: id,
          role: turn.role,
          text: turn.content,
          model: meta.model,
        })
      } catch {
        // Mirror is best-effort — failures here shouldn't break the local
        // canonical write that already succeeded.
      }
    }
  }

  /** Read full transcript ordered oldest -> newest. */
  loadTurns(id: string): Turn[] {
    const path = this.jsonlPath(id)
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    const out: Turn[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as Turn
        if (parsed.role === 'user' || parsed.role === 'assistant') {
          out.push(parsed)
        }
      } catch {
        // skip malformed lines
      }
    }
    return out
  }

  /** Most recent session whose cwd matches. Used by `-c / --continue`. */
  findLatestByCwd(cwd: string): SessionMeta | null {
    const idx = this.readIndex()
    const matching = idx.sessions
      .filter((s) => s.cwd === cwd)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return matching[0] ?? null
  }

  /** Look up by exact id (for `-r <id>`). */
  get(id: string): SessionMeta | null {
    const idx = this.readIndex()
    return idx.sessions.find((s) => s.id === id) ?? null
  }

  list(): SessionMeta[] {
    return this.readIndex().sessions
  }

  /**
   * Render a stored transcript as a human-readable history block to prepend
   * to the next user prompt. Used by Phase A's "flatten history" approach
   * because V2 sessions can't inject arbitrary assistant turns.
   */
  formatHistoryPrefix(id: string, opts: { maxChars?: number } = {}): string {
    const turns = this.loadTurns(id)
    if (turns.length === 0) return ''
    const maxChars = opts.maxChars ?? 200_000
    const segments: string[] = ['<conversation_history>']
    for (const t of turns) {
      segments.push(`[${t.role}] ${t.content}`)
    }
    segments.push('</conversation_history>', '', 'Continue the above conversation.')
    let block = segments.join('\n')
    if (block.length > maxChars) {
      block = block.slice(block.length - maxChars)
    }
    return block + '\n\n'
  }

  /** Bulk-load turns into the local jsonl without triggering the official
   * mirror (used to import an existing official session whose jsonl is
   * already authoritative). */
  importRawTurns(id: string, turns: Turn[]): void {
    if (turns.length === 0) return
    const path = this.jsonlPath(id)
    const lines = turns.map((t) => JSON.stringify(t)).join('\n') + '\n'
    appendFileSync(path, lines)
    const idx = this.readIndex()
    const meta = idx.sessions.find((s) => s.id === id)
    if (meta) {
      meta.turnCount += turns.length
      const lastTs = turns[turns.length - 1]?.ts
      if (typeof lastTs === 'number') meta.lastUsedAt = lastTs
      this.writeIndex(idx)
    }
  }

  /** Bump lastUsedAt without writing a turn (e.g. on session start). */
  touch(id: string): void {
    const idx = this.readIndex()
    const meta = idx.sessions.find((s) => s.id === id)
    if (!meta) return
    meta.lastUsedAt = Math.floor(Date.now() / 1000)
    this.writeIndex(idx)
  }

  private jsonlPath(id: string): string {
    return join(this.dir, `${id}.jsonl`)
  }

  private readIndex(): IndexFile {
    const path = join(this.dir, INDEX_NAME)
    if (!existsSync(path)) return { sessions: [] }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as IndexFile
      if (Array.isArray(parsed?.sessions)) return parsed
    } catch {
      // corrupt — start fresh; we still keep individual jsonl files
    }
    return { sessions: [] }
  }

  private writeIndex(idx: IndexFile): void {
    const path = join(this.dir, INDEX_NAME)
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(idx, null, 2))
  }
}

export function defaultStoreDir(): string {
  return join(homedir(), '.claude-sdk', 'sessions')
}

/** Bare list helper for `--list-sessions` style usage (not wired yet). */
export function listSessions(opts: SessionStoreOptions = {}): SessionMeta[] {
  const store = new SessionStore(opts)
  return store.list()
}
