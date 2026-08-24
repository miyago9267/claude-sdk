import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FileSessionStore,
  InMemorySessionStore,
  SessionRegistry,
} from './sessions.ts'

const record = {
  sessionKey: 'bot-1:user-1:thread-1',
  botId: 'bot-1',
  status: 'active' as const,
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
  metadata: { channel: 'test' },
}

describe('SessionRegistry', () => {
  test('creates a session once and updates its metadata', async () => {
    const registry = new SessionRegistry(new InMemorySessionStore())
    const first = await registry.getOrCreate(record)
    const second = await registry.getOrCreate({ ...record, metadata: { changed: true } })

    expect(second).toEqual(first)
    expect(await registry.update(record.sessionKey, { sdkSessionId: 'sdk-1' })).toMatchObject({
      sdkSessionId: 'sdk-1',
    })
  })

  test('serializes work for one session key', async () => {
    const registry = new SessionRegistry(new InMemorySessionStore())
    const order: string[] = []

    await Promise.all([
      registry.withLock('session-1', async () => {
        order.push('first:start')
        await Promise.resolve()
        order.push('first:end')
      }),
      registry.withLock('session-1', async () => {
        order.push('second:start')
        order.push('second:end')
      }),
    ])

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})

describe('FileSessionStore', () => {
  test('persists records as hashed JSON files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-sessions-'))
    const store = new FileSessionStore(directory)

    await store.save(record)

    const loaded = await store.get(record.sessionKey)
    expect(loaded).toEqual(record)
    const files = await store.list()
    expect(files).toHaveLength(1)
    expect(await readFile(files[0]!.path, 'utf8')).toContain('bot-1:user-1:thread-1')
  })
})
