import { describe, expect, test } from 'bun:test'

import { parseArgs } from './args.ts'

describe('parseArgs', () => {
  test('positional prompt -> oneshot', () => {
    const a = parseArgs(['hello world'])
    expect(a.mode).toBe('oneshot')
    expect(a.prompt).toBe('hello world')
  })

  test('multi-word positional joins', () => {
    const a = parseArgs(['hello', 'world'])
    expect(a.prompt).toBe('hello world')
  })

  test('-p / --print', () => {
    const a = parseArgs(['-p', 'hi'])
    expect(a.mode).toBe('oneshot')
    expect(a.prompt).toBe('hi')

    const b = parseArgs(['--print', 'yo'])
    expect(b.mode).toBe('oneshot')
    expect(b.prompt).toBe('yo')
  })

  test('--serve overrides oneshot', () => {
    const a = parseArgs(['--serve', '--port', '5000'])
    expect(a.mode).toBe('serve')
    expect(a.port).toBe(5000)
  })

  test('-h triggers help mode', () => {
    expect(parseArgs(['-h']).mode).toBe('help')
    expect(parseArgs(['--help']).mode).toBe('help')
  })

  test('no args -> repl', () => {
    expect(parseArgs([]).mode).toBe('repl')
  })

  test('options without prompt stay in repl', () => {
    const a = parseArgs(['-m', 'claude-haiku-4-5'])
    expect(a.mode).toBe('repl')
    expect(a.model).toBe('claude-haiku-4-5')
  })

  test('unknown option throws', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/)
  })

  test('numeric options coerce', () => {
    const a = parseArgs(['--max-turns', '7', '--watermark', '100000', 'go'])
    expect(a.maxTurns).toBe(7)
    expect(a.watermark).toBe(100_000)
    expect(a.prompt).toBe('go')
  })
})
