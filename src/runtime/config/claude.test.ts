import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importClaudeSettings, loadClaudeSettings } from './claude.ts'

describe('Claude settings adapter', () => {
  test('imports runtime settings and normalized permission rules', () => {
    const layer = importClaudeSettings({
      model: 'opus[1m]',
      fallbackModel: ['sonnet'],
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' },
      permissions: {
        allow: ['Read(*)', 'Bash(*)'],
        deny: ['Bash(rm *)'],
        ask: ['Write(*)'],
      },
    })

    expect(layer.config).toMatchObject({
      model: 'opus[1m]',
      fallbackModels: ['sonnet'],
      environment: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100' },
      toolRules: [
        { tool: 'Write', decision: 'ask-human' },
        { tool: 'Read', decision: 'allow' },
        { tool: 'Bash', decision: 'allow' },
      ],
    })
    expect(layer.diagnostics).toContainEqual(expect.objectContaining({
      code: 'unsupported',
      field: 'permissions.deny[0]',
    }))
  })

  test('keeps deny ahead of allow for the same broad tool rule', () => {
    const layer = importClaudeSettings({
      permissions: {
        allow: ['Bash(*)'],
        deny: ['Bash(*)'],
      },
    })

    expect(layer.config.toolRules).toEqual([
      { tool: 'Bash', decision: 'deny' },
      { tool: 'Bash', decision: 'allow' },
    ])
  })

  test('does not import hooks or client-only directories', () => {
    const layer = importClaudeSettings({
      hooks: { SessionStart: [] },
      permissions: { additionalDirectories: ['/tmp/shared'] },
    })

    expect(layer.config).toEqual({})
    expect(layer.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'hooks', code: 'unsupported' }),
      expect.objectContaining({ field: 'permissions.additionalDirectories', code: 'unsupported' }),
    ]))
  })

  test('loads settings JSON without writing to the source file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-settings-'))
    const path = join(directory, 'settings.json')
    const content = JSON.stringify({ model: 'sonnet' })
    await writeFile(path, content)

    const layer = await loadClaudeSettings(path)

    expect(layer.config.model).toBe('sonnet')
    expect(await Bun.file(path).text()).toBe(content)
  })
})
