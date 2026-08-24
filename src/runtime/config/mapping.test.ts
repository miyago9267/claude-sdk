import { describe, expect, test } from 'bun:test'

import { runtimeConfigToAgentOptions } from './mapping.ts'

describe('RuntimeConfig SDK mapping', () => {
  test('maps safe fields and keeps inherited environment', () => {
    const result = runtimeConfigToAgentOptions({
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      environment: { BOT_MODE: 'test' },
    })

    expect(result.options).toMatchObject({
      model: 'claude-sonnet-4-6',
      effort: 'high',
      permissionMode: 'dontAsk',
      sandbox: { enabled: true, failIfUnavailable: true },
      env: { BOT_MODE: 'test' },
    })
    expect(result.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(result.policy).toEqual({
      sandboxRequired: true,
      sandboxMode: 'workspace-write',
      approvalMode: 'deny',
    })
  })

  test('maps configured fallback models to the official comma-separated option', () => {
    const result = runtimeConfigToAgentOptions({ fallbackModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'] })

    expect(result.options.fallbackModel).toBe('claude-sonnet-4-5,claude-haiku-4-5')
    expect(result.diagnostics).toEqual([])
  })

  test('does not grant unsandboxed execution for danger-full-access', () => {
    const result = runtimeConfigToAgentOptions({ sandboxMode: 'danger-full-access' })

    expect(result.options.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true })
    expect(result.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'unsafe', field: 'sandboxMode' }))
  })

  test('fails closed for unsupported approval and effort values', () => {
    const result = runtimeConfigToAgentOptions({ reasoningEffort: 'turbo', approvalPolicy: 'on-failure' })

    expect(result.options.effort).toBeUndefined()
    expect(result.options.permissionMode).toBe('default')
    expect(result.policy.approvalMode).toBe('default')
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsupported', field: 'reasoningEffort' }),
      expect.objectContaining({ code: 'unsupported', field: 'approvalPolicy' }),
    ]))
  })
})
