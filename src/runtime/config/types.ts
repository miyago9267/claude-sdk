export type RuntimeSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type RuntimeToolDecision = 'allow' | 'deny' | 'ask-human'

export interface RuntimeToolRule {
  tool: string
  decision: RuntimeToolDecision
  reason?: string
}

export interface RuntimeConfig {
  model?: string
  fallbackModels?: string[]
  reasoningEffort?: string
  sandboxMode?: RuntimeSandboxMode
  approvalPolicy?: string
  environment?: Record<string, string>
  toolRules?: RuntimeToolRule[]
}

export interface ConfigDiagnostic {
  level: 'warning' | 'error'
  code: 'unsupported' | 'override' | 'invalid' | 'unsafe'
  field: string
  source: string
  message: string
}

export interface ConfigLayer {
  source: string
  config: RuntimeConfig
  diagnostics?: ConfigDiagnostic[]
}

export interface ResolvedRuntimeConfig {
  config: RuntimeConfig
  sources: string[]
  diagnostics: ConfigDiagnostic[]
}
