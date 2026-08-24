import { readFile } from 'node:fs/promises'

import type { ConfigDiagnostic, ConfigLayer, RuntimeToolDecision, RuntimeToolRule } from './types.ts'

export type ClaudeSettingsDocument = Record<string, unknown>

export interface ClaudeSettingsOptions {
  source?: string
}

export function importClaudeSettings(document: ClaudeSettingsDocument, source = 'claude'): ConfigLayer {
  const diagnostics: ConfigDiagnostic[] = []
  const config: ConfigLayer['config'] = {}

  if (typeof document.model === 'string') config.model = document.model
  else if ('model' in document) diagnostics.push(invalid('model', source, 'must be a string'))

  if ('fallbackModel' in document) {
    const fallback = document.fallbackModel
    if (typeof fallback === 'string') config.fallbackModels = [fallback]
    else if (Array.isArray(fallback) && fallback.every((value) => typeof value === 'string')) {
      config.fallbackModels = [...fallback]
    } else diagnostics.push(invalid('fallbackModel', source, 'must be a string or string array'))
  }

  if ('env' in document) {
    const env = document.env
    if (!env || typeof env !== 'object' || Array.isArray(env)) {
      diagnostics.push(invalid('env', source, 'must be an object'))
    } else {
      const values: Record<string, string> = {}
      for (const [key, value] of Object.entries(env)) {
        if (typeof value === 'string') values[key] = value
        else diagnostics.push(invalid(`env.${key}`, source, 'must be a string'))
      }
      config.environment = values
    }
  }

  const permissions = asRecord(document.permissions)
  const toolRules: RuntimeToolRule[] = []
  if (permissions) {
    for (const [field, decision] of [
      ['deny', 'deny'],
      ['ask', 'ask-human'],
      ['allow', 'allow'],
    ] as const) {
      const values = permissions[field]
      if (values === undefined) continue
      if (!Array.isArray(values)) {
        diagnostics.push(invalid(`permissions.${field}`, source, 'must be an array'))
        continue
      }
      for (const [index, value] of values.entries()) {
        if (typeof value !== 'string') {
          diagnostics.push(invalid(`permissions.${field}[${index}]`, source, 'must be a string'))
          continue
        }
        const tool = normalizeBroadPermission(value)
        if (!tool) {
          diagnostics.push({
            level: 'warning',
            code: 'unsupported',
            field: `permissions.${field}[${index}]`,
            source,
            message: `Permission argument constraint was not widened to a tool rule: ${value}`,
          })
          continue
        }
        toolRules.push({ tool, decision: decision as RuntimeToolDecision })
      }
    }
    if (toolRules.length > 0) config.toolRules = toolRules
    if ('additionalDirectories' in permissions) {
      diagnostics.push({
        level: 'warning',
        code: 'unsupported',
        field: 'permissions.additionalDirectories',
        source,
        message: 'Additional directories require an explicit workspace policy and were not imported',
      })
    }
  }

  for (const field of ['hooks', 'statusLine', 'statusline']) {
    if (field in document) {
      diagnostics.push({
        level: 'warning',
        code: 'unsupported',
        field,
        source,
        message: `Claude client setting was not imported: ${field}`,
      })
    }
  }

  return { source, config, diagnostics }
}

export async function loadClaudeSettings(path: string, options: ClaudeSettingsOptions = {}): Promise<ConfigLayer> {
  const content = await readFile(path, 'utf8')
  let document: unknown
  try {
    document = JSON.parse(content)
  } catch (error) {
    throw new Error(`invalid Claude settings JSON: ${path}`, { cause: error })
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Claude settings root must be an object: ${path}`)
  }
  return importClaudeSettings(document as ClaudeSettingsDocument, options.source ?? `claude:${path}`)
}

function normalizeBroadPermission(value: string): string | undefined {
  const match = /^([^()]+)\(([^()]*)\)$/.exec(value)
  if (!match) return value
  return match[2] === '*' ? match[1] : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function invalid(field: string, source: string, message: string): ConfigDiagnostic {
  return { level: 'error', code: 'invalid', field, source, message }
}
