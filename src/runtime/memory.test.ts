import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemoryMemoryProvider, MarkdownMemoryProvider } from './memory.ts'

const entry = {
  id: 'memory-1',
  scope: { botId: 'bot-1', userId: 'user-1' },
  content: 'Miyago prefers concise engineering summaries.',
  tags: ['preference'],
  createdAt: '2026-08-24T00:00:00.000Z',
  updatedAt: '2026-08-24T00:00:00.000Z',
}

describe('MemoryProvider', () => {
  test('isolates search results by scope', async () => {
    const memory = new InMemoryMemoryProvider()
    await memory.write(entry)
    await memory.write({ ...entry, id: 'memory-2', scope: { botId: 'bot-2', userId: 'user-1' } })

    expect(await memory.search('concise', entry.scope)).toHaveLength(1)
    expect(await memory.search('concise', { botId: 'bot-3' })).toHaveLength(0)
  })

  test('forgets an entry explicitly', async () => {
    const memory = new InMemoryMemoryProvider()
    await memory.write(entry)
    await memory.forget(entry.id, entry.scope)

    expect(await memory.search('concise', entry.scope)).toHaveLength(0)
  })
})

describe('MarkdownMemoryProvider', () => {
  test('persists entries as scoped Markdown and reloads them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-memory-'))
    const first = new MarkdownMemoryProvider(directory)
    await first.write(entry)

    const second = new MarkdownMemoryProvider(directory)
    const results = await second.search('engineering', entry.scope)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ id: entry.id, content: entry.content })
  })

  test('keeps different scopes in separate files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-memory-'))
    const memory = new MarkdownMemoryProvider(directory)
    await memory.write(entry)
    await memory.write({ ...entry, id: 'memory-2', scope: { botId: 'bot-1' } })

    expect(await memory.search('concise', entry.scope)).toHaveLength(1)
    expect(await memory.search('concise', { botId: 'bot-1' })).toHaveLength(1)
  })
})
