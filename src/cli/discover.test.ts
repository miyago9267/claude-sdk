import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { discoverCommands, discoverSkills, formatList } from './discover.ts'

function makeTempProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'cs-discover-'))
  return root
}

describe('discoverCommands', () => {
  test('finds project-local .claude/commands/*.md', () => {
    const root = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(root, '.claude/commands'), { recursive: true })
      writeFileSync(
        join(root, '.claude/commands/foo.md'),
        '---\ndescription: do foo\n---\nbody',
      )
      const cmds = discoverCommands({ cwd: root, home })
      const foo = cmds.find((c) => c.name === '/foo')
      expect(foo).toBeDefined()
      expect(foo?.source).toBe('project')
      expect(foo?.description).toBe('do foo')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('returns [] when no commands directory anywhere', () => {
    const root = makeTempProject()
    const home = makeTempProject()
    try {
      expect(discoverCommands({ cwd: root, home })).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('plugin commands also surface', () => {
    const root = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(home, '.claude/plugins/my-plugin/commands'), { recursive: true })
      writeFileSync(
        join(home, '.claude/plugins/my-plugin/commands/zap.md'),
        '---\ndescription: zap it\n---\n',
      )
      const cmds = discoverCommands({ cwd: root, home })
      const zap = cmds.find((c) => c.name === '/zap')
      expect(zap).toBeDefined()
      expect(zap?.source).toBe('plugin')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('plugin-prefixed skill IDs', () => {
  test("plugin-source skills get '<plugin>:<name>' to match cli.js", () => {
    const root = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(home, '.claude/plugins/dev-discipline/skills/tdd-guide'), { recursive: true })
      writeFileSync(
        join(home, '.claude/plugins/dev-discipline/skills/tdd-guide/SKILL.md'),
        '---\ndescription: TDD\n---\n',
      )
      const { discoverSkills } = require('./discover.ts') as typeof import('./discover.ts')
      const list = discoverSkills({ cwd: root, home })
      expect(list.find((s) => s.name === 'dev-discipline:tdd-guide')).toBeDefined()
      // Project-source skills stay unprefixed.
      mkdirSync(join(root, '.claude/skills/local-only'), { recursive: true })
      writeFileSync(
        join(root, '.claude/skills/local-only/SKILL.md'),
        '---\ndescription: local\n---\n',
      )
      const list2 = discoverSkills({ cwd: root, home })
      expect(list2.find((s) => s.name === 'local-only')).toBeDefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('discoverSkills', () => {
  test('finds project-local .claude/skills/<name>/SKILL.md', () => {
    const root = makeTempProject()
    const home = makeTempProject()
    try {
      mkdirSync(join(root, '.claude/skills/my-skill'), { recursive: true })
      writeFileSync(
        join(root, '.claude/skills/my-skill/SKILL.md'),
        '---\nname: my-skill\ndescription: skill desc\n---\nbody',
      )
      const skills = discoverSkills({ cwd: root, home })
      const s = skills.find((c) => c.name === 'my-skill')
      expect(s).toBeDefined()
      expect(s?.source).toBe('project')
      expect(s?.description).toBe('skill desc')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('formatList', () => {
  test('formats with title and count', () => {
    const out = formatList('Commands', [
      { name: '/foo', source: 'project', description: 'do foo' },
      { name: '/bar', source: 'user' },
    ])
    expect(out).toContain('Commands (2):')
    expect(out).toContain('/foo  [project]  do foo')
    expect(out).toContain('/bar  [user]')
  })

  test('handles empty list', () => {
    expect(formatList('Skills', [])).toBe('Skills: (none found)')
  })
})
