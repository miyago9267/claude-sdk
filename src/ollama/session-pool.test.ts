import { describe, expect, test } from 'bun:test'

import type { V2Session } from '../shared/query-session.ts'

import { SessionPool, hashHistoryPrefix } from './session-pool.ts'

function makeFakeSession(label: string): V2Session {
  let closed = false
  return {
    get sessionId() {
      return label
    },
    send: async () => undefined,
    stream: async function* () {
      /* no-op generator */
    },
    close: () => {
      closed = true
    },
    [Symbol.asyncDispose]: async () => {
      closed = true
    },
    // expose a marker for tests
    __label: label,
    get __closed() {
      return closed
    },
  } as unknown as V2Session
}

describe('SessionPool', () => {
  test('acquire returns null on miss', () => {
    const pool = new SessionPool()
    expect(pool.acquire('nonexistent')).toBeNull()
  })

  test('register + acquire round-trips by hash', () => {
    const pool = new SessionPool()
    const s = makeFakeSession('a')
    pool.register('h1', s)
    expect(pool.acquire('h1')).toBe(s)
  })

  test('register replaces same-session old hash entry', () => {
    const pool = new SessionPool()
    const s = makeFakeSession('a')
    pool.register('h1', s)
    pool.register('h2', s) // session moved
    expect(pool.acquire('h1')).toBeNull()
    expect(pool.acquire('h2')).toBe(s)
    expect(pool.size()).toBe(1)
  })

  test('LRU evicts oldest when size exceeds max', () => {
    const pool = new SessionPool({ max: 2 })
    const a = makeFakeSession('a')
    const b = makeFakeSession('b')
    const c = makeFakeSession('c')
    pool.register('ha', a)
    pool.register('hb', b)
    pool.register('hc', c) // evicts ha (oldest)
    expect(pool.acquire('ha')).toBeNull()
    expect(pool.acquire('hb')).toBe(b)
    expect(pool.acquire('hc')).toBe(c)
    expect((a as unknown as { __closed: boolean }).__closed).toBe(true)
  })

  test('LRU promotes on acquire so frequently used sessions survive eviction', () => {
    const pool = new SessionPool({ max: 2 })
    const a = makeFakeSession('a')
    const b = makeFakeSession('b')
    const c = makeFakeSession('c')
    pool.register('ha', a)
    pool.register('hb', b)
    pool.acquire('ha') // promote a → MRU
    pool.register('hc', c) // evicts hb (now LRU)
    expect(pool.acquire('ha')).toBe(a)
    expect(pool.acquire('hb')).toBeNull()
  })

  test('TTL: expired sessions are purged on next acquire', async () => {
    const pool = new SessionPool({ idleTtlMs: 10 })
    const s = makeFakeSession('s')
    pool.register('h', s)
    await new Promise((r) => setTimeout(r, 20))
    expect(pool.acquire('h')).toBeNull()
    expect((s as unknown as { __closed: boolean }).__closed).toBe(true)
  })

  test('evictBySession removes + closes by reference', () => {
    const pool = new SessionPool()
    const s = makeFakeSession('s')
    pool.register('h', s)
    pool.evictBySession(s)
    expect(pool.size()).toBe(0)
    expect((s as unknown as { __closed: boolean }).__closed).toBe(true)
  })

  test('closeAll drops every entry', () => {
    const pool = new SessionPool()
    const a = makeFakeSession('a')
    const b = makeFakeSession('b')
    pool.register('ha', a)
    pool.register('hb', b)
    pool.closeAll()
    expect(pool.size()).toBe(0)
    expect((a as unknown as { __closed: boolean }).__closed).toBe(true)
    expect((b as unknown as { __closed: boolean }).__closed).toBe(true)
  })

  test('size reports correct count', () => {
    const pool = new SessionPool()
    expect(pool.size()).toBe(0)
    pool.register('h1', makeFakeSession('a'))
    pool.register('h2', makeFakeSession('b'))
    expect(pool.size()).toBe(2)
  })
})

describe('hashHistoryPrefix', () => {
  test('same input → same hash', () => {
    const a = hashHistoryPrefix('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ])
    const b = hashHistoryPrefix('claude-sonnet-4-6', [
      { role: 'user', content: 'hi' },
    ])
    expect(a).toBe(b)
  })

  test('different model → different hash', () => {
    const a = hashHistoryPrefix('claude-opus-4-7', [{ role: 'user', content: 'x' }])
    const b = hashHistoryPrefix('claude-sonnet-4-6', [{ role: 'user', content: 'x' }])
    expect(a).not.toBe(b)
  })

  test('different content → different hash', () => {
    const a = hashHistoryPrefix('m', [{ role: 'user', content: 'x' }])
    const b = hashHistoryPrefix('m', [{ role: 'user', content: 'y' }])
    expect(a).not.toBe(b)
  })

  test('tool_calls participate in hash', () => {
    const a = hashHistoryPrefix('m', [
      { role: 'assistant', toolCalls: [{ name: 'A', arguments: {} }] },
    ])
    const b = hashHistoryPrefix('m', [
      { role: 'assistant', toolCalls: [{ name: 'B', arguments: {} }] },
    ])
    expect(a).not.toBe(b)
  })

  test('hash is deterministic across calls (sha256 hex)', () => {
    const h = hashHistoryPrefix('m', [{ role: 'user', content: 'x' }])
    expect(h).toMatch(/^[0-9a-f]{64}$/)
  })

  test('image-count and image-content both flip hash (no length-collision reuse)', () => {
    const oneImg = hashHistoryPrefix('m', [{ role: 'user', content: 'x', images: ['A'] }])
    const twoImg = hashHistoryPrefix('m', [
      { role: 'user', content: 'x', images: ['A', 'A'] },
    ])
    expect(oneImg).not.toBe(twoImg)
    const sameLenDiff = hashHistoryPrefix('m', [{ role: 'user', content: 'x', images: ['B'] }])
    expect(oneImg).not.toBe(sameLenDiff)
    const sameBytes = hashHistoryPrefix('m', [{ role: 'user', content: 'x', images: ['A'] }])
    expect(oneImg).toBe(sameBytes)
  })

  test('large images differing only past prefix window still collide (documented bound)', () => {
    const head = 'x'.repeat(4096)
    const a = hashHistoryPrefix('m', [{ role: 'user', content: 'q', images: [head + 'AAA'] }])
    const b = hashHistoryPrefix('m', [{ role: 'user', content: 'q', images: [head + 'BBB'] }])
    expect(a).toBe(b)
  })
})
