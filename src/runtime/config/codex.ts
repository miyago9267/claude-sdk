import { readFile } from 'node:fs/promises'

import type { ConfigDiagnostic, ConfigLayer } from './types.ts'

export type CodexConfigDocument = Record<string, unknown>

export interface CodexTomlOptions {
  source?: string
  parse?: (content: string) => unknown
}

export function importCodexConfig(document: CodexConfigDocument, source = 'codex'): ConfigLayer {
  const diagnostics: ConfigDiagnostic[] = []
  const config: ConfigLayer['config'] = {}

  assignString(document, 'model', config, 'model', source, diagnostics)
  assignString(document, 'model_reasoning_effort', config, 'reasoningEffort', source, diagnostics)
  assignString(document, 'sandbox_mode', config, 'sandboxMode', source, diagnostics)
  assignString(document, 'approval_policy', config, 'approvalPolicy', source, diagnostics)

  for (const field of ['tool_output_token_limit', 'plugins', 'tui']) {
    if (field in document) {
      diagnostics.push({
        level: 'warning',
        code: 'unsupported',
        field,
        source,
        message: `Codex field is client-specific and was not imported: ${field}`,
      })
    }
  }

  return { source, config, diagnostics }
}

export async function parseCodexToml(content: string, options: CodexTomlOptions = {}): Promise<ConfigLayer> {
  const parse = options.parse ?? defaultTomlParser
  const document = parse(content)
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Codex TOML root must be an object')
  }
  return importCodexConfig(document as CodexConfigDocument, options.source ?? 'codex')
}

export async function loadCodexConfig(path: string, options: CodexTomlOptions = {}): Promise<ConfigLayer> {
  return parseCodexToml(await readFile(path, 'utf8'), { ...options, source: options.source ?? `codex:${path}` })
}

function assignString(
  document: CodexConfigDocument,
  inputField: string,
  config: ConfigLayer['config'],
  outputField: 'model' | 'reasoningEffort' | 'sandboxMode' | 'approvalPolicy',
  source: string,
  diagnostics: ConfigDiagnostic[],
): void {
  if (!(inputField in document)) return
  const value = document[inputField]
  if (typeof value !== 'string') {
    diagnostics.push({
      level: 'error',
      code: 'invalid',
      field: inputField,
      source,
      message: `Codex field must be a string: ${inputField}`,
    })
    return
  }
  if (outputField === 'sandboxMode' && !['read-only', 'workspace-write', 'danger-full-access'].includes(value)) {
    diagnostics.push({
      level: 'error',
      code: 'invalid',
      field: inputField,
      source,
      message: `Unsupported Codex sandbox mode: ${value}`,
    })
    return
  }
  config[outputField] = value as never
}

function defaultTomlParser(content: string): unknown {
  const runtime = globalThis as typeof globalThis & {
    Bun?: { TOML?: { parse: (source: string) => unknown } }
  }
  const parse = runtime.Bun?.TOML?.parse
  if (!parse) throw new Error('Codex TOML loading requires Bun.TOML or an injected parser')
  return parse(content)
}
