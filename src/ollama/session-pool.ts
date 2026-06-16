/**
 * In-memory pool of V2 SDK sessions keyed by client-history prefix hash.
 *
 * Why this exists: Copilot's OpenAI-compat client is stateless — every chat
 * call replays the entire conversation history. Spawning a fresh V2 session
 * per request means a 5-10s child-process cold start every time and blows
 * away the prompt cache. By keying sessions on a hash of the messages-up-to-
 * but-not-including the final user turn, we can reuse a live session
 * across consecutive turns of the same conversation: hit means "send only
 * the last user message"; miss means "spawn fresh and replay full prompt".
 *
 * Pool semantics:
 *   acquire(prefixHash) → V2Session | null  (LRU-promotes on hit)
 *   register(nextHash, session)               (called after each turn ends;
 *                                              moves the session to the new
 *                                              hash key for the next call)
 *   evictBySession(s)                         (error path; closes + drops)
 *   closeAll()                                (process shutdown)
 *
 * No background timer — expired entries are purged opportunistically on
 * acquire(). Branch detection happens implicitly: a divergent prefix hash
 * just misses, spawning a new session. The old branch stays in the pool
 * until LRU/TTL evicts it.
 */

import { createHash } from 'node:crypto'

import type { HistoryMessage } from '../shared/messages.ts'
import type { V2Session } from '../shared/query-session.ts'

export interface PooledSession {
  session: V2Session
  lastTouchedAt: number
}

export interface SessionPoolOptions {
  /** Max live sessions. LRU evicts the least-recently-used when exceeded. */
  max?: number
  /** Sessions idle longer than this get closed on next acquire(). */
  idleTtlMs?: number
}

export const DEFAULT_POOL_MAX = 50
export const DEFAULT_POOL_IDLE_TTL_MS = 30 * 60_000

export class SessionPool {
  private readonly max: number
  private readonly idleTtlMs: number
  /** Insertion-order Map = LRU when we delete+re-set on access. */
  private readonly entries = new Map<string, PooledSession>()

  constructor(opts: SessionPoolOptions = {}) {
    this.max = opts.max ?? DEFAULT_POOL_MAX
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_POOL_IDLE_TTL_MS
  }

  /** Look up a session by prefix hash; promotes to MRU on hit. */
  acquire(prefixHash: string): V2Session | null {
    this.purgeExpired()
    const entry = this.entries.get(prefixHash)
    if (!entry) return null
    this.entries.delete(prefixHash)
    entry.lastTouchedAt = Date.now()
    this.entries.set(prefixHash, entry)
    return entry.session
  }

  /**
   * Register a session under a new prefix hash (its post-turn shape). If the
   * session was previously stored under a different hash, the old entry is
   * removed so each session occupies exactly one slot.
   */
  register(nextPrefixHash: string, session: V2Session): void {
    for (const [h, e] of this.entries) {
      if (e.session === session && h !== nextPrefixHash) {
        this.entries.delete(h)
      }
    }
    this.entries.set(nextPrefixHash, {
      session,
      lastTouchedAt: Date.now(),
    })
    this.enforceMax()
  }

  /** Drop+close a session by reference (typically the error path). */
  evictBySession(session: V2Session): void {
    for (const [h, e] of this.entries) {
      if (e.session === session) {
        this.evictHash(h)
        return
      }
    }
  }

  /** Close every live session and clear the pool (process shutdown). */
  closeAll(): void {
    for (const entry of this.entries.values()) safeClose(entry.session)
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }

  private evictHash(hash: string): void {
    const entry = this.entries.get(hash)
    if (!entry) return
    safeClose(entry.session)
    this.entries.delete(hash)
  }

  private purgeExpired(): void {
    const now = Date.now()
    for (const [h, e] of this.entries) {
      if (now - e.lastTouchedAt > this.idleTtlMs) {
        safeClose(e.session)
        this.entries.delete(h)
      }
    }
  }

  private enforceMax(): void {
    while (this.entries.size > this.max) {
      const first = this.entries.keys().next().value as string | undefined
      if (!first) break
      this.evictHash(first)
    }
  }
}

/**
 * Stable hash of (model, history-prefix). Used as pool key. Images are
 * fingerprinted by sha256 over a bounded prefix + length so different image
 * payloads with matching length no longer collide into the same session.
 */
const IMAGE_FINGERPRINT_PREFIX_CHARS = 4096

function fingerprintImage(image: string): [string, number] {
  const prefix = image.length > IMAGE_FINGERPRINT_PREFIX_CHARS
    ? image.slice(0, IMAGE_FINGERPRINT_PREFIX_CHARS)
    : image
  const digest = createHash('sha256').update(prefix).digest('hex').slice(0, 16)
  return [digest, image.length]
}

export function hashHistoryPrefix(model: string, messages: HistoryMessage[]): string {
  const canonical = JSON.stringify({
    model,
    msgs: messages.map((m) => [
      m.role,
      m.content ?? '',
      m.toolCalls?.map((tc) => [tc.name, tc.arguments]) ?? null,
      m.toolName ?? null,
      m.toolCallId ?? null,
      m.images?.map(fingerprintImage) ?? null,
    ]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function safeClose(session: V2Session): void {
  try {
    session.close()
  } catch {
    /* already closed */
  }
}
