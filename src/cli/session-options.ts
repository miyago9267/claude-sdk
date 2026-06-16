/**
 * Translate ParsedArgs into V2 session options. Centralised so REPL, oneshot
 * and (future) resume paths all build sessions identically.
 */

import type {
  Options,
  PermissionMode,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk'

import { RECOMMENDED_SUBPROCESS_ENV } from '../context-manager.ts'
import type { ParsedArgs } from './args.ts'

export interface BuildSessionOptions {
  args: ParsedArgs
  defaultModel?: string
  includePartialMessages?: boolean
}

export function buildSessionOptions(opts: BuildSessionOptions): Options {
  const { args, defaultModel = 'claude-sonnet-4-6', includePartialMessages = true } = opts

  const systemPrompt = args.systemPrompt
    ? (args.appendSystemPrompt ? `${args.systemPrompt}\n\n${args.appendSystemPrompt}` : args.systemPrompt)
    : args.appendSystemPrompt

  const settingSources = (args.settingSources ?? ['user', 'project', 'local']) as SettingSource[]

  return {
    model: args.model ?? defaultModel,
    cwd: args.cwd ?? process.cwd(),
    systemPrompt,
    additionalDirectories: args.addDir,
    settingSources,
    permissionMode: (args.permissionMode ?? 'bypassPermissions') as PermissionMode,
    allowDangerouslySkipPermissions: args.allowDangerouslySkipPermissions ?? true,
    maxTurns: args.maxTurns ?? 10,
    allowedTools: args.allowedTools,
    disallowedTools: args.disallowedTools,
    includePartialMessages,
    env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
  }
}
