import { describe, expect, test } from 'bun:test'

import { parseArgs } from './args.ts'

describe('parseArgs', () => {
  test('no mode flag -> help (CLI is a launcher; chat lives in the bridge/library)', () => {
    expect(parseArgs([]).mode).toBe('help')
  })

  test('positional prompt without --ollama/--tui -> help (prompt still parsed for TUI seeding)', () => {
    const a = parseArgs(['hello world'])
    expect(a.mode).toBe('help')
    expect(a.prompt).toBe('hello world')
  })

  test('multi-word positional joins', () => {
    expect(parseArgs(['hello', 'world']).prompt).toBe('hello world')
  })

  test('--ollama -> ollama', () => {
    const a = parseArgs(['--ollama', '--port', '5000'])
    expect(a.mode).toBe('ollama')
    expect(a.port).toBe(5000)
    expect(a.ollama).toBe(true)
  })

  test('--tui -> tui', () => {
    const a = parseArgs(['--tui'])
    expect(a.mode).toBe('tui')
    expect(a.tui).toBe(true)
  })

  test('-p is no longer a flag (oneshot removed) -> unknown option', () => {
    expect(() => parseArgs(['-p', 'hi'])).toThrow(/Unknown option/)
  })

  test('-h / --help / -v / --version', () => {
    expect(parseArgs(['-h']).mode).toBe('help')
    expect(parseArgs(['--help']).mode).toBe('help')
    expect(parseArgs(['-v']).mode).toBe('version')
    expect(parseArgs(['--version']).mode).toBe('version')
  })

  test('options without a mode flag stay in help', () => {
    const a = parseArgs(['--model', 'sonnet'])
    expect(a.mode).toBe('help')
    expect(a.model).toBe('sonnet')
  })

  test('unknown option throws', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
  })

  test('unsupported official options collected, not thrown', () => {
    const a = parseArgs(['--mcp-config', 'foo.json', 'go'])
    expect(a.unsupported).toContain('--mcp-config')
    expect(a.prompt).toBe('go')
  })

  test('--add-dir comma split', () => {
    const a = parseArgs(['--add-dir', '/a,/b,/c'])
    expect(a.addDir).toEqual(['/a', '/b', '/c'])
  })

  test('--add-dir repeated accumulates', () => {
    const a = parseArgs(['--add-dir', '/a', '--add-dir', '/b'])
    expect(a.addDir).toEqual(['/a', '/b'])
  })

  test('--allowedTools / --disallowedTools', () => {
    const a = parseArgs(['--allowedTools', 'Bash,Edit', '--disallowed-tools', 'Write'])
    expect(a.allowedTools).toEqual(['Bash', 'Edit'])
    expect(a.disallowedTools).toEqual(['Write'])
  })

  test('--permission-mode', () => {
    expect(parseArgs(['--permission-mode', 'plan']).permissionMode).toBe('plan')
  })

  test('--allow-dangerously-skip-permissions', () => {
    expect(parseArgs(['--allow-dangerously-skip-permissions']).allowDangerouslySkipPermissions).toBe(true)
    expect(parseArgs(['--dangerously-skip-permissions']).allowDangerouslySkipPermissions).toBe(true)
  })

  test('--setting-sources', () => {
    expect(parseArgs(['--setting-sources', 'user,local']).settingSources).toEqual(['user', 'local'])
  })

  test('-c, --continue boolean', () => {
    expect(parseArgs(['-c']).continue).toBe(true)
    expect(parseArgs(['--continue']).continue).toBe(true)
  })

  test('-r, --resume takes value', () => {
    expect(parseArgs(['-r', 'sess-id']).resume).toBe('sess-id')
  })

  test('-d / --debug optional filter', () => {
    expect(parseArgs(['-d']).debug).toBe(true)
    expect(parseArgs(['--debug', 'api,hooks']).debug).toBe('api,hooks')
    expect(parseArgs(['-d', 'go']).debug).toBe('go')
  })

  test('numeric options coerce', () => {
    const a = parseArgs(['--max-turns', '7', '--watermark', '100000', 'go'])
    expect(a.maxTurns).toBe(7)
    expect(a.watermark).toBe(100_000)
    expect(a.prompt).toBe('go')
  })

  test('--system-prompt and --append-system-prompt', () => {
    const a = parseArgs(['--system-prompt', 'sys', '--append-system-prompt', 'more', 'go'])
    expect(a.systemPrompt).toBe('sys')
    expect(a.appendSystemPrompt).toBe('more')
  })

  test('-d takes value when next is not a flag', () => {
    const a = parseArgs(['-d', 'api', '--model', 'sonnet'])
    expect(a.debug).toBe('api')
    expect(a.model).toBe('sonnet')
  })
})
