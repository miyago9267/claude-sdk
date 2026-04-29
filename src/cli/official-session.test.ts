import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { OfficialResolver } from './official-session.ts'

function makeHome() {
  return mkdtempSync(join(tmpdir(), 'cs-official-'))
}

describe('OfficialResolver.encodeCwd', () => {
  const r = new OfficialResolver({ home: '/dev/null' })
  test.each([
    ['/Users/miyago/Project/AI/claude-sdk', '-Users-miyago-Project-AI-claude-sdk'],
    ['/Users/miyago/.claude', '-Users-miyago--claude'],
    ['/Users/miyago/dotfile/config/ai/claude', '-Users-miyago-dotfile-config-ai-claude'],
  ])('encodes %s -> %s', (input, expected) => {
    expect(r.encodeCwd(input)).toBe(expected)
  })
})

describe('OfficialResolver lifecycle', () => {
  test('appendOfficialTurn writes a permission-mode header + user/assistant records', () => {
    const home = makeHome()
    try {
      const r = new OfficialResolver({ home })
      const sessionId = '00000000-0000-0000-0000-000000000001'
      r.appendOfficialTurn({
        cwd: '/tmp/proj',
        sessionId,
        role: 'user',
        text: 'hello',
      })
      r.appendOfficialTurn({
        cwd: '/tmp/proj',
        sessionId,
        role: 'assistant',
        text: 'hi back',
        model: 'claude-haiku-4-5',
      })
      const turns = r.loadTurns(r.jsonlPath('/tmp/proj', sessionId))
      expect(turns).toHaveLength(2)
      expect(turns[0]).toMatchObject({ role: 'user', content: 'hello' })
      expect(turns[1]).toMatchObject({ role: 'assistant', content: 'hi back' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('findLatestByCwd reads timestamps to pick the newest jsonl', () => {
    const home = makeHome()
    try {
      const r = new OfficialResolver({ home })
      const dir = r.projectDir('/p')
      mkdirSync(dir, { recursive: true })
      // Older
      writeFileSync(join(dir, 'older.jsonl'), [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'older' }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'x' },
          uuid: 'u1',
          timestamp: '2024-01-01T00:00:00.000Z',
          cwd: '/p',
          sessionId: 'older',
        }),
      ].join('\n') + '\n')
      writeFileSync(join(dir, 'newer.jsonl'), [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'newer' }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'x' },
          uuid: 'u2',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: '/p',
          sessionId: 'newer',
        }),
      ].join('\n') + '\n')

      const latest = r.findLatestByCwd('/p')
      expect(latest?.id).toBe('newer')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('loadTurns flattens block-array assistant content into text', () => {
    const home = makeHome()
    try {
      const r = new OfficialResolver({ home })
      const dir = r.projectDir('/p')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, 'sess.jsonl')
      writeFileSync(path, [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'sess' }),
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'hi' },
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: '/p',
          sessionId: 'sess',
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'noise' },
              { type: 'text', text: 'hello world' },
              { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
            ],
          },
          uuid: 'u2',
          timestamp: '2026-01-01T00:00:01.000Z',
          cwd: '/p',
          sessionId: 'sess',
        }),
      ].join('\n') + '\n')

      const turns = r.loadTurns(path)
      expect(turns).toHaveLength(2)
      expect(turns[0]?.content).toBe('hi')
      expect(turns[1]?.content).toContain('hello world')
      expect(turns[1]?.content).toContain('[tool_use: Bash]')
      expect(turns[1]?.content).not.toContain('thinking')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('findById walks all project dirs', () => {
    const home = makeHome()
    try {
      const r = new OfficialResolver({ home })
      const dir = r.projectDir('/another')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'aaa.jsonl'), [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'hi' },
          uuid: 'u1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: '/another',
          sessionId: 'aaa',
        }),
      ].join('\n') + '\n')
      const meta = r.findById('aaa')
      expect(meta?.cwd).toBe('/another')
      expect(meta?.id).toBe('aaa')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
