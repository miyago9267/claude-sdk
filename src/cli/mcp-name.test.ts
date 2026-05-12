import { describe, expect, test } from 'bun:test'
import { parseMcpToolName } from './tui.ts'

describe('parseMcpToolName', () => {
  test('parses standard mcp__server__tool', () => {
    expect(parseMcpToolName('mcp__codex__exec')).toEqual({ server: 'codex', tool: 'exec' })
  })

  test('keeps __ inside tool name intact (matches cli.js PT())', () => {
    expect(parseMcpToolName('mcp__weird__do__thing')).toEqual({
      server: 'weird',
      tool: 'do__thing',
    })
  })

  test('multiple __ in tool name preserved', () => {
    expect(parseMcpToolName('mcp__s__a__b__c')).toEqual({ server: 's', tool: 'a__b__c' })
  })

  test('returns null for non-mcp names', () => {
    expect(parseMcpToolName('Bash')).toBeNull()
    expect(parseMcpToolName('Skill')).toBeNull()
    expect(parseMcpToolName('Read')).toBeNull()
  })

  test('null when prefix matches but server is empty', () => {
    expect(parseMcpToolName('mcp____foo')).toBeNull()
  })

  test('empty tool when only server present', () => {
    expect(parseMcpToolName('mcp__codex')).toEqual({ server: 'codex', tool: '' })
  })
})
