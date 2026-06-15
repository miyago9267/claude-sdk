import { describe, expect, test } from 'bun:test'
import { resolveModel, formatKnownModels } from './models.ts'

describe('resolveModel', () => {
  test('passes through known short aliases verbatim', () => {
    expect(resolveModel('opus')).toEqual({ model: 'opus', known: true })
    expect(resolveModel('sonnet')).toEqual({ model: 'sonnet', known: true })
    expect(resolveModel('haiku')).toEqual({ model: 'haiku', known: true })
  })

  test('passes through known full IDs verbatim', () => {
    expect(resolveModel('claude-opus-4-7')).toEqual({ model: 'claude-opus-4-7', known: true })
    expect(resolveModel('claude-sonnet-4-6')).toEqual({ model: 'claude-sonnet-4-6', known: true })
  })

  test("converts '.' to '-' for known revisions", () => {
    expect(resolveModel('claude-opus-4.6')).toEqual({ model: 'claude-opus-4-6', known: true })
  })

  test("adds missing 'claude-' prefix for known shapes", () => {
    expect(resolveModel('opus-4-6')).toEqual({ model: 'claude-opus-4-6', known: true })
    expect(resolveModel('opus-4.6')).toEqual({ model: 'claude-opus-4-6', known: true })
    expect(resolveModel('sonnet-4-6')).toEqual({ model: 'claude-sonnet-4-6', known: true })
  })

  test('passes through unknown values, normalising dots', () => {
    const r = resolveModel('claude-future-9.0')
    expect(r.model).toBe('claude-future-9-0')
    expect(r.known).toBe(false)
  })

  test('empty input -> empty result', () => {
    expect(resolveModel('  ')).toEqual({ model: '', known: false })
  })
})

describe('resolveModel — newly advertised models', () => {
  test('claude-opus-4-8 is known', () => {
    expect(resolveModel('claude-opus-4-8')).toEqual({ model: 'claude-opus-4-8', known: true })
  })

  test('claude-fable-5 is known (advertised; a call surfaces the upstream access error)', () => {
    expect(resolveModel('claude-fable-5')).toEqual({ model: 'claude-fable-5', known: true })
  })
})

describe('formatKnownModels', () => {
  test('lists all known models with aliases when available', () => {
    const text = formatKnownModels()
    expect(text).toContain('claude-opus-4-7')
    expect(text).toContain('alias: opus')
    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('alias: sonnet')
  })

  test('advertises current flagship + fable (fable is not granted on subscription)', () => {
    const text = formatKnownModels()
    expect(text).toContain('claude-opus-4-8')
    expect(text).toContain('claude-fable-5')
  })
})
