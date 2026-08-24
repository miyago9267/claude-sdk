import { describe, expect, test } from 'bun:test'

import { ToolPolicyEngine } from './policy.ts'

const context = {
  botId: 'bot-1',
  sessionKey: 'bot-1:user-1',
  userId: 'user-1',
  environment: 'development',
  sandboxed: false,
}

describe('ToolPolicyEngine', () => {
  test('matches explicit tool rules before the default decision', () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'deny',
      rules: [
        { tool: 'Read', decision: 'allow', reason: 'read-only' },
        { tool: 'Bash', decision: 'ask-human', reason: 'command execution' },
      ],
    })

    expect(policy.evaluate({ ...context, toolName: 'Read', input: {} })).toMatchObject({
      decision: 'allow',
      reason: 'read-only',
    })
    expect(policy.evaluate({ ...context, toolName: 'Write', input: {} }).decision).toBe('deny')
  })

  test('supports wildcard rules and scope matching', () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'deny',
      rules: [
        { tool: 'mcp__*', decision: 'allow', environment: 'development' },
        { tool: 'Bash', decision: 'allow', botId: 'other-bot' },
      ],
    })

    expect(policy.evaluate({ ...context, toolName: 'mcp__search', input: {} }).decision).toBe('allow')
    expect(policy.evaluate({ ...context, toolName: 'Bash', input: {} }).decision).toBe('deny')
  })

  test('requires sandbox for require-sandbox decisions', () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'deny',
      rules: [{ tool: 'Bash', decision: 'require-sandbox' }],
    })

    expect(policy.evaluate({ ...context, toolName: 'Bash', input: {} })).toMatchObject({
      decision: 'deny',
      reason: 'sandbox is required',
    })
    expect(
      policy.evaluate({ ...context, sandboxed: true, toolName: 'Bash', input: {} }).decision,
    ).toBe('allow')
  })

  test('maps ask-human through an approval provider', async () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'ask-human',
      rules: [],
    })
    const canUseTool = policy.createCanUseTool(context, async (request) => {
      expect(request.toolName).toBe('Bash')
      return 'allow'
    })

    await expect(canUseTool('Bash', { command: 'pwd' }, { signal: new AbortController().signal })).resolves.toEqual({
      behavior: 'allow',
    })
  })

  test('fails closed when ask-human has no approval provider', async () => {
    const policy = new ToolPolicyEngine({ defaultDecision: 'ask-human', rules: [] })
    const result = await policy.createCanUseTool(context)('Bash', {}, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ behavior: 'deny' })
  })

  test('enforces runtime sandbox requirement before tool rules', () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'allow',
      rules: [],
      requireSandbox: true,
    })

    expect(policy.evaluate({ ...context, toolName: 'Read', input: {} }).decision).toBe('deny')
    expect(policy.evaluate({ ...context, sandboxed: true, toolName: 'Read', input: {} }).decision).toBe('allow')
  })

  test('does not route ask-human to approval when runtime approval is denied', async () => {
    const policy = new ToolPolicyEngine({
      defaultDecision: 'ask-human',
      rules: [],
      approvalMode: 'deny',
    })
    const result = await policy.createCanUseTool(context, async () => 'allow')('Bash', {}, {
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ behavior: 'deny' })
  })
})
