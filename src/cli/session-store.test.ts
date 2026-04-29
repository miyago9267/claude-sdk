import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionStore } from './session-store.ts'

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-store-'))
  return { store: new SessionStore({ dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }), dir }
}

describe('SessionStore', () => {
  test('create + appendTurn + loadTurns round-trips', () => {
    const { store, cleanup } = makeStore()
    try {
      const meta = store.create({ cwd: '/x', model: 'claude-sonnet-4-6' })
      expect(meta.id).toBeTruthy()
      expect(meta.cwd).toBe('/x')

      store.appendTurn(meta.id, { role: 'user', content: 'hi' })
      store.appendTurn(meta.id, { role: 'assistant', content: 'hello' })

      const turns = store.loadTurns(meta.id)
      expect(turns).toHaveLength(2)
      expect(turns[0]).toMatchObject({ role: 'user', content: 'hi' })
      expect(turns[1]).toMatchObject({ role: 'assistant', content: 'hello' })

      const fresh = store.get(meta.id)
      expect(fresh?.turnCount).toBe(2)
    } finally {
      cleanup()
    }
  })

  test('findLatestByCwd picks most-recent matching cwd', async () => {
    const { store, cleanup } = makeStore()
    try {
      const a = store.create({ cwd: '/a', model: 'sonnet' })
      const b1 = store.create({ cwd: '/b', model: 'sonnet' })
      // make b1 older than b2
      store.appendTurn(a.id, { role: 'user', content: 'x', ts: 100 })
      store.appendTurn(b1.id, { role: 'user', content: 'old', ts: 200 })
      const b2 = store.create({ cwd: '/b', model: 'sonnet' })
      store.appendTurn(b2.id, { role: 'user', content: 'new', ts: 300 })

      expect(store.findLatestByCwd('/b')?.id).toBe(b2.id)
      expect(store.findLatestByCwd('/a')?.id).toBe(a.id)
      expect(store.findLatestByCwd('/c')).toBeNull()
    } finally {
      cleanup()
    }
  })

  test('formatHistoryPrefix renders a continuation block', () => {
    const { store, cleanup } = makeStore()
    try {
      const m = store.create({ cwd: '/p', model: 'sonnet' })
      store.appendTurn(m.id, { role: 'user', content: 'first' })
      store.appendTurn(m.id, { role: 'assistant', content: 'reply' })
      const prefix = store.formatHistoryPrefix(m.id)
      expect(prefix).toContain('<conversation_history>')
      expect(prefix).toContain('[user] first')
      expect(prefix).toContain('[assistant] reply')
      expect(prefix).toContain('</conversation_history>')
      expect(prefix).toContain('Continue the above conversation.')
    } finally {
      cleanup()
    }
  })

  test('formatHistoryPrefix returns empty string when no turns', () => {
    const { store, cleanup } = makeStore()
    try {
      const m = store.create({ cwd: '/p', model: 'sonnet' })
      expect(store.formatHistoryPrefix(m.id)).toBe('')
    } finally {
      cleanup()
    }
  })

  test('formatHistoryPrefix truncates from the front when exceeding maxChars', () => {
    const { store, cleanup } = makeStore()
    try {
      const m = store.create({ cwd: '/p', model: 'sonnet' })
      const filler = 'x'.repeat(1000)
      store.appendTurn(m.id, { role: 'user', content: filler })
      store.appendTurn(m.id, { role: 'assistant', content: 'tail-content' })
      const prefix = store.formatHistoryPrefix(m.id, { maxChars: 200 })
      expect(prefix.length).toBeLessThanOrEqual(200 + 'Continue the above conversation.\n\n'.length)
      expect(prefix).toContain('tail-content')
    } finally {
      cleanup()
    }
  })

  test('survives corrupt _index.json by starting empty', () => {
    const { store, cleanup, dir } = makeStore()
    try {
      // First create a real session, then corrupt the index.
      store.create({ cwd: '/x', model: 'sonnet' })
      const indexPath = join(dir, '_index.json')
      require('node:fs').writeFileSync(indexPath, 'not json')
      const fresh = new SessionStore({ dir })
      expect(fresh.list()).toEqual([])
    } finally {
      cleanup()
    }
  })
})
