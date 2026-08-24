import { readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import type { Options } from '@anthropic-ai/claude-agent-sdk'

import {
  ToolPolicyEngine,
  type ApprovalProvider,
  type ToolPolicyConfig,
} from './policy.ts'
import { runtimeConfigToAgentOptions, type RuntimeConfig } from './config/index.ts'

export interface BotManifest {
  id: string
  workspace: string
  model?: string
  provider?: string
  systemPrompt?: string
  bootstrapFiles?: string[]
  skills?: string[]
  tools?: { allowed?: string[]; disallowed?: string[] }
  policy?: ToolPolicyConfig
  budget?: { perRunUSD?: number }
  concurrency?: { perBot?: number; perUser?: number }
}

export interface WorkspaceBootstrapDocument {
  name: string
  path: string
  content: string
  trust: 'workspace'
}

export interface WorkspaceBootstrap {
  workspace: string
  documents: WorkspaceBootstrapDocument[]
}

export interface BotInvocationContext {
  sessionKey: string
  userId?: string
  environment?: string
  sandboxed?: boolean
  runtimeConfig?: RuntimeConfig
}

export class BotRegistry {
  private readonly manifests = new Map<string, BotManifest>()

  register(manifest: BotManifest): void {
    const normalized = validateBotManifest(manifest)
    if (this.manifests.has(normalized.id)) throw new Error(`bot already registered: ${normalized.id}`)
    this.manifests.set(normalized.id, normalized)
  }

  get(botId: string): BotManifest | undefined {
    return this.manifests.get(botId)
  }

  list(): BotManifest[] {
    return [...this.manifests.values()]
  }
}

export function validateBotManifest(value: unknown, baseDirectory?: string): BotManifest {
  if (!value || typeof value !== 'object') throw new Error('bot manifest must be an object')
  const candidate = value as Partial<BotManifest>
  if (!candidate.id || typeof candidate.id !== 'string') throw new Error('bot manifest requires id')
  if (!candidate.workspace || typeof candidate.workspace !== 'string') {
    throw new Error('bot manifest requires workspace')
  }
  const workspace = isAbsolute(candidate.workspace)
    ? candidate.workspace
    : resolve(baseDirectory ?? process.cwd(), candidate.workspace)
  if (candidate.policy?.defaultDecision === undefined) {
    candidate.policy = { defaultDecision: 'deny', rules: candidate.policy?.rules ?? [] }
  }
  return { ...candidate, workspace } as BotManifest
}

export async function loadBotManifest(path: string): Promise<BotManifest> {
  const content = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`invalid bot manifest JSON: ${path}`, { cause: error })
  }
  return validateBotManifest(parsed, dirname(resolve(path)))
}

export async function loadWorkspaceBootstrap(
  workspace: string,
  files = ['AGENTS.md', 'CLAUDE.md'],
): Promise<WorkspaceBootstrap> {
  const root = await realpath(workspace)
  const documents: WorkspaceBootstrapDocument[] = []
  for (const name of files) {
    const candidate = resolve(root, name)
    const target = await realpath(candidate).catch(() => undefined)
    if (!target) continue
    const outside = relative(root, target).startsWith('../') || isAbsolute(relative(root, target))
    if (outside) throw new Error(`bootstrap file escapes workspace: ${name}`)
    documents.push({ name, path: target, content: await readFile(target, 'utf8'), trust: 'workspace' })
  }
  return { workspace: root, documents }
}

export function buildBotOptions(
  manifest: BotManifest,
  context: BotInvocationContext,
  approval?: ApprovalProvider,
): Options {
  const mapping = context.runtimeConfig
    ? runtimeConfigToAgentOptions(context.runtimeConfig)
    : { options: {}, policy: { sandboxRequired: false, approvalMode: 'default' as const }, diagnostics: [] }
  const unsafe = mapping.diagnostics.filter((diagnostic) => diagnostic.level === 'error' || diagnostic.code === 'unsafe')
  if (unsafe.length > 0) {
    throw new Error(`unsafe runtime config: ${unsafe.map((diagnostic) => diagnostic.message).join('; ')}`)
  }
  const policy = new ToolPolicyEngine({
    ...manifest.policy,
    rules: [
      ...(manifest.policy?.rules ?? []),
      ...(mapping.policy.toolRules ?? []),
    ],
    requireSandbox: Boolean(manifest.policy?.requireSandbox || mapping.policy.sandboxRequired),
    approvalMode: manifest.policy?.approvalMode ?? mapping.policy.approvalMode,
  })
  return {
    ...mapping.options,
    cwd: manifest.workspace,
    ...(manifest.model ? { model: manifest.model } : {}),
    ...(manifest.systemPrompt ? { systemPrompt: manifest.systemPrompt } : {}),
    ...(manifest.tools?.allowed ? { tools: manifest.tools.allowed } : {}),
    ...(manifest.tools?.disallowed ? { disallowedTools: manifest.tools.disallowed } : {}),
    ...(manifest.budget?.perRunUSD !== undefined ? { maxBudgetUsd: manifest.budget.perRunUSD } : {}),
    canUseTool: policy.createCanUseTool(
      {
        botId: manifest.id,
        sessionKey: context.sessionKey,
        ...(context.userId ? { userId: context.userId } : {}),
        ...(context.environment ? { environment: context.environment } : {}),
        ...(context.sandboxed !== undefined ? { sandboxed: context.sandboxed } : {}),
        workspace: manifest.workspace,
      },
      approval,
    ),
  }
}
