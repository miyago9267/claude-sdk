import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverHooks, formatHooks } from './hooks-config.ts'

function makeTempProject() {
  return mkdtempSync(join(tmpdir(), 'cs-hooks-'))
}

describe('discoverHooks', () => {
  test('reads simple project-level config', () => {
    const cwd = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [{ type: 'command', command: 'echo hi', timeout: 5 }],
          },
        }),
      )
      const cfg = discoverHooks({ cwd, home })
      expect(cfg.events.PreToolUse?.length).toBe(1)
      expect(cfg.events.PreToolUse?.[0]).toMatchObject({
        command: 'echo hi',
        timeout: 5,
        source: 'project',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('flattens the grouped {matcher, hooks:[...]} shape', () => {
    const cwd = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: 'Write',
                hooks: [{ type: 'command', command: 'lint.sh', shell: 'bash' }],
              },
            ],
          },
        }),
      )
      const cfg = discoverHooks({ cwd, home })
      expect(cfg.events.PostToolUse?.[0]).toMatchObject({
        command: 'lint.sh',
        shell: 'bash',
        source: 'user',
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('merges project + user without overriding', () => {
    const cwd = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(cwd, '.claude'), { recursive: true })
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(
        join(cwd, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { Stop: [{ type: 'command', command: 'a.sh' }] } }),
      )
      writeFileSync(
        join(home, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { Stop: [{ type: 'command', command: 'b.sh' }] } }),
      )
      const cfg = discoverHooks({ cwd, home })
      const sources = cfg.events.Stop?.map((h) => h.source) ?? []
      expect(sources).toContain('project')
      expect(sources).toContain('user')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('formatHooks renders empty-state message', () => {
    expect(formatHooks({ events: {} })).toBe('No hooks configured.')
  })

  test('formatHooks renders multi-event output', () => {
    const out = formatHooks({
      events: {
        PreToolUse: [{ command: 'a.sh', source: 'user' }],
        PostToolUse: [{ command: 'b.sh', source: 'project', shell: 'bash' }],
      },
    })
    expect(out).toContain('Configured hooks (2 events)')
    expect(out).toContain('PreToolUse:')
    expect(out).toContain('[user] a.sh')
    expect(out).toContain('[project] b.sh (bash)')
  })
})
