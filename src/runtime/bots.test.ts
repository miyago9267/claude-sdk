import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BotRegistry,
  buildBotOptions,
  loadBotManifest,
  loadWorkspaceBootstrap,
} from './bots.ts'

describe('bot manifest', () => {
  test('loads a manifest and resolves workspace relative to the manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-bot-'))
    const workspace = join(directory, 'workspace')
    const path = join(directory, 'bot.json')
    await writeFile(
      path,
      JSON.stringify({
        id: 'coding-bot',
        workspace: './workspace',
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a coding bot.',
      }),
    )

    const manifest = await loadBotManifest(path)
    expect(manifest).toMatchObject({ id: 'coding-bot', workspace, model: 'claude-sonnet-4-6' })

    const registry = new BotRegistry()
    registry.register(manifest)
    expect(registry.get('coding-bot')).toEqual(manifest)
  })

  test('loads bootstrap files without merging them into trusted system prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'claude-sdk-workspace-'))
    await writeFile(join(workspace, 'AGENTS.md'), 'workspace instructions')
    await writeFile(join(workspace, 'CLAUDE.md'), 'project instructions')

    const bootstrap = await loadWorkspaceBootstrap(workspace)

    expect(bootstrap.documents.map((document) => document.name)).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(bootstrap.documents[0]).toMatchObject({
      trust: 'workspace',
      content: 'workspace instructions',
    })
  })

  test('builds SDK options with policy callback and manifest limits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-bot-'))
    const manifest = {
      id: 'safe-bot',
      workspace: directory,
      model: 'claude-sonnet-4-6',
      tools: { allowed: ['Read', 'Bash'], disallowed: ['Bash'] },
      budget: { perRunUSD: 2 },
      policy: { defaultDecision: 'deny' as const, rules: [{ tool: 'Read', decision: 'allow' as const }] },
    }

    const options = buildBotOptions(manifest, { sessionKey: 'safe-bot:user-1' })
    expect(options).toMatchObject({
      cwd: directory,
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Bash'],
      disallowedTools: ['Bash'],
      maxBudgetUsd: 2,
    })
    await expect(options.canUseTool!('Read', {}, { signal: new AbortController().signal })).resolves.toEqual({
      behavior: 'allow',
    })
  })

  test('connects runtime config to SDK options and policy while keeping manifest precedence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-bot-'))
    const options = buildBotOptions(
      {
        id: 'config-bot',
        workspace: directory,
        model: 'claude-opus-4-6',
        policy: { defaultDecision: 'allow', rules: [] },
      },
      {
        sessionKey: 'config-bot:session-1',
        sandboxed: true,
        runtimeConfig: {
          model: 'claude-sonnet-4-6',
          reasoningEffort: 'high',
          approvalPolicy: 'never',
          sandboxMode: 'workspace-write',
        },
      },
    )

    expect(options).toMatchObject({
      model: 'claude-opus-4-6',
      effort: 'high',
      permissionMode: 'dontAsk',
      sandbox: { enabled: true, failIfUnavailable: true },
    })
    await expect(options.canUseTool!('Read', {}, { signal: new AbortController().signal })).resolves.toEqual({
      behavior: 'allow',
    })
  })

  test('denies tools when imported config requires sandbox but invocation is unsandboxed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-bot-'))
    const options = buildBotOptions(
      {
        id: 'sandbox-bot',
        workspace: directory,
        policy: { defaultDecision: 'allow', rules: [] },
      },
      {
        sessionKey: 'sandbox-bot:session-1',
        runtimeConfig: { sandboxMode: 'read-only' },
      },
    )

    await expect(options.canUseTool!('Read', {}, { signal: new AbortController().signal })).resolves.toMatchObject({
      behavior: 'deny',
    })
  })

  test('fails fast on an unsafe imported privilege mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'claude-sdk-bot-'))

    expect(() => buildBotOptions(
      { id: 'unsafe-bot', workspace: directory },
      { sessionKey: 'unsafe-bot:session-1', runtimeConfig: { sandboxMode: 'danger-full-access' } },
    )).toThrow('unsafe')
  })
})
