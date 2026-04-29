/**
 * Phase B: read & write the official Claude Code session schema at
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl so resume interop
 * works in both directions:
 *
 *   - claude -r <id>         can resume a claude-sdk session
 *   - claude-sdk -r <id>     can resume an official claude session
 *   - both -c                can pick whichever file in the cwd is newest
 *
 * We don't reconstruct every official record (file-history-snapshots,
 * permission-mode events, sidechain trees, thinking blocks). Just the
 * minimum that round-trips: leading permission-mode, then a chain of
 * type:user / type:assistant messages with parentUuid / promptId / uuid
 * / timestamp / cwd / sessionId / gitBranch.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Turn } from './session-store.ts'
import { readGitBranch } from './git-info.ts'

export interface OfficialMeta {
  id: string
  cwd: string
  jsonlPath: string
  lastUsedAt: number
  turnCount: number
  model?: string
}

export interface OfficialResolverOptions {
  /** Override $HOME, used only by tests. */
  home?: string
}

const PROJECTS_SUBDIR = '.claude/projects'

export class OfficialResolver {
  private readonly home: string

  constructor(opts: OfficialResolverOptions = {}) {
    this.home = opts.home ?? homedir()
  }

  /** Convert a cwd into the directory name claude.exe uses. */
  encodeCwd(cwd: string): string {
    return cwd.replace(/[/.]/g, '-')
  }

  projectDir(cwd: string): string {
    return join(this.home, PROJECTS_SUBDIR, this.encodeCwd(cwd))
  }

  jsonlPath(cwd: string, id: string): string {
    return join(this.projectDir(cwd), `${id}.jsonl`)
  }

  /** Find a session by exact id across all project dirs. O(n) over project
   * dirs but in practice the user only has a handful. */
  findById(id: string): OfficialMeta | null {
    const root = join(this.home, PROJECTS_SUBDIR)
    let projects: string[]
    try {
      projects = readdirSync(root)
    } catch {
      return null
    }
    for (const dir of projects) {
      const full = join(root, dir, `${id}.jsonl`)
      if (existsSync(full)) {
        return this.readMeta(full)
      }
    }
    return null
  }

  /** Newest session in this cwd, or null. */
  findLatestByCwd(cwd: string): OfficialMeta | null {
    const dir = this.projectDir(cwd)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return null
    }
    const candidates: OfficialMeta[] = []
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue
      const path = join(dir, name)
      const meta = this.readMeta(path)
      if (meta) candidates.push(meta)
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    return candidates[0] ?? null
  }

  /** Parse an official jsonl into our internal Turn[] (text content only,
   * tool blocks are summarised). */
  loadTurns(path: string): Turn[] {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return []
    }
    const out: Turn[] = []
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      let parsed: any
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed?.type !== 'user' && parsed?.type !== 'assistant') continue
      const tsIso = parsed.timestamp as string | undefined
      const ts = tsIso ? Math.floor(Date.parse(tsIso) / 1000) : Math.floor(Date.now() / 1000)
      const content = stringifyOfficialContent(parsed?.message?.content)
      if (!content) continue
      out.push({ role: parsed.type, content, ts })
    }
    return out
  }

  /** Same flatten-history-into-prompt approach as SessionStore, fed from an
   * official jsonl. */
  formatHistoryPrefix(path: string, opts: { maxChars?: number } = {}): string {
    const turns = this.loadTurns(path)
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

  /**
   * Append a turn to the official jsonl using the minimum-viable record
   * shape. Caller passes the sessionId (we treat it as fixed for the
   * file's lifetime; phase B pairs every claude-sdk logical id with one
   * official sessionId per cwd).
   */
  appendOfficialTurn(args: {
    cwd: string
    sessionId: string
    role: 'user' | 'assistant'
    text: string
    /** Optional parentUuid to chain on. */
    parentUuid?: string
    promptId?: string
    model?: string
    version?: string
  }): { uuid: string } {
    const dir = this.projectDir(args.cwd)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = this.jsonlPath(args.cwd, args.sessionId)
    if (!existsSync(path)) {
      appendFileSync(path, JSON.stringify({
        type: 'permission-mode',
        permissionMode: 'default',
        sessionId: args.sessionId,
      }) + '\n')
    }
    const uuid = randomUUID()
    const branch = readGitBranch(args.cwd) ?? ''
    const isoTimestamp = new Date().toISOString()
    const promptId = args.promptId ?? randomUUID()

    let record: Record<string, unknown>
    if (args.role === 'user') {
      record = {
        parentUuid: args.parentUuid ?? null,
        isSidechain: false,
        promptId,
        type: 'user',
        message: { role: 'user', content: args.text },
        uuid,
        timestamp: isoTimestamp,
        permissionMode: 'default',
        userType: 'external',
        entrypoint: 'cli',
        cwd: args.cwd,
        sessionId: args.sessionId,
        version: args.version ?? '0.0.0-claude-sdk',
        gitBranch: branch,
      }
    } else {
      record = {
        parentUuid: args.parentUuid ?? null,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: args.model ?? 'claude-sonnet-4-6',
          id: 'msg_' + uuid.replace(/-/g, '').slice(0, 24),
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: args.text }],
        },
        uuid,
        timestamp: isoTimestamp,
        permissionMode: 'default',
        cwd: args.cwd,
        sessionId: args.sessionId,
        version: args.version ?? '0.0.0-claude-sdk',
        gitBranch: branch,
      }
    }
    appendFileSync(path, JSON.stringify(record) + '\n')
    return { uuid }
  }

  /** Pull metadata (turn count, last timestamp) by scanning a jsonl. */
  private readMeta(path: string): OfficialMeta | null {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    let cwd = ''
    let id = path.split('/').pop()!.replace(/\.jsonl$/, '')
    let turnCount = 0
    let lastTs = 0
    let model: string | undefined
    for (const raw of lines) {
      let parsed: any
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (typeof parsed?.cwd === 'string' && !cwd) cwd = parsed.cwd
      if (typeof parsed?.sessionId === 'string') id = parsed.sessionId
      if (parsed?.type === 'user' || parsed?.type === 'assistant') {
        turnCount += 1
        if (typeof parsed?.timestamp === 'string') {
          const t = Math.floor(Date.parse(parsed.timestamp) / 1000)
          if (t > lastTs) lastTs = t
        }
        if (parsed.type === 'assistant' && parsed?.message?.model) {
          model = parsed.message.model
        }
      }
    }
    if (lastTs === 0) {
      try {
        lastTs = Math.floor(statSync(path).mtimeMs / 1000)
      } catch {
        lastTs = 0
      }
    }
    return { id, cwd, jsonlPath: path, lastUsedAt: lastTs, turnCount, model }
  }
}

function stringifyOfficialContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string') parts.push(b.text)
        break
      case 'tool_use':
        parts.push(`[tool_use: ${String(b.name ?? 'unknown')}]`)
        break
      case 'tool_result': {
        const txt = stringifyOfficialContent(b.content)
        if (txt) parts.push(`[tool_result] ${txt.slice(0, 240)}`)
        break
      }
      case 'thinking':
        // skip — rebuilding thinking content adds noise without benefit
        break
      default:
        break
    }
  }
  return parts.join('\n').trim()
}
