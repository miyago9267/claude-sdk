import { describe, expect, test } from 'bun:test'

import { importCodexConfig, parseCodexToml } from './codex.ts'
import { resolveRuntimeConfig } from './resolver.ts'

describe('Codex config adapter', () => {
  test('imports supported runtime fields without importing client-only settings', () => {
    const layer = importCodexConfig({
      model: 'gpt-5.5',
      model_reasoning_effort: 'medium',
      sandbox_mode: 'workspace-write',
      approval_policy: 'never',
      tool_output_token_limit: 12000,
      plugins: { github: { enabled: true } },
      tui: { theme: 'rainbow' },
    })

    expect(layer.config).toEqual({
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })
    expect(layer.diagnostics.map((item) => item.code)).toEqual([
      'unsupported',
      'unsupported',
      'unsupported',
    ])
  })

  test('parses TOML through an injected parser and remains read-only', async () => {
    let parserCalled = false
    const layer = await parseCodexToml('model = "gpt-5.5"', {
      source: 'codex:test',
      parse: (source) => {
        parserCalled = source.includes('gpt-5.5')
        return { model: 'gpt-5.5' }
      },
    })

    expect(parserCalled).toBe(true)
    expect(layer.config.model).toBe('gpt-5.5')
  })

  test('loads the supported Codex TOML subset with the Bun parser', async () => {
    const layer = await parseCodexToml('model = "gpt-5.5"\nsandbox_mode = "read-only"')

    expect(layer.config).toMatchObject({ model: 'gpt-5.5', sandboxMode: 'read-only' })
  })
})

describe('Runtime config resolver', () => {
  test('applies later layers and reports overrides', () => {
    const result = resolveRuntimeConfig([
      { source: 'codex', config: { model: 'gpt-5.5', reasoningEffort: 'medium' } },
      { source: 'project', config: { model: 'claude-sonnet-4-6', environment: { MODE: 'project' } } },
      { source: 'run', config: { environment: { MODE: 'run', TRACE: '1' } } },
    ])

    expect(result.config).toEqual({
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'medium',
      environment: { MODE: 'run', TRACE: '1' },
    })
    expect(result.sources).toEqual(['codex', 'project', 'run'])
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'override', field: 'model' }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'override', field: 'environment.MODE' }))
  })
})
