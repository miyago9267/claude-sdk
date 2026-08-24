import type { Options } from '@anthropic-ai/claude-agent-sdk'

import type { ConfigDiagnostic, RuntimeConfig, RuntimeSandboxMode } from './types.ts'

export interface RuntimePolicyInputs {
  sandboxRequired: boolean
  sandboxMode?: RuntimeSandboxMode
  approvalMode: 'default' | 'deny'
  toolRules?: RuntimeConfig['toolRules']
}

export interface RuntimeConfigMapping {
  options: Pick<Options, 'model' | 'fallbackModel' | 'effort' | 'permissionMode' | 'sandbox' | 'env'>
  policy: RuntimePolicyInputs
  diagnostics: ConfigDiagnostic[]
}

export function runtimeConfigToAgentOptions(config: RuntimeConfig, source = 'runtime-config'): RuntimeConfigMapping {
  const diagnostics: ConfigDiagnostic[] = []
  const options: RuntimeConfigMapping['options'] = {}
  const policy: RuntimePolicyInputs = {
    sandboxRequired: false,
    approvalMode: 'default',
    ...(config.toolRules ? { toolRules: config.toolRules } : {}),
  }

  if (config.model !== undefined) options.model = config.model
  if (config.fallbackModels?.[0] !== undefined) options.fallbackModel = config.fallbackModels[0]
  if (config.fallbackModels && config.fallbackModels.length > 1) {
    diagnostics.push({
      level: 'warning',
      code: 'unsupported',
      field: 'fallbackModels',
      source,
      message: 'Claude Agent SDK accepts one fallbackModel; only the first fallback model is mapped',
    })
  }
  if (config.environment !== undefined) options.env = { ...process.env, ...config.environment }

  if (config.reasoningEffort !== undefined) {
    if (isEffort(config.reasoningEffort)) options.effort = config.reasoningEffort
    else diagnostics.push(unsupported('reasoningEffort', config.reasoningEffort, source))
  }

  if (config.approvalPolicy !== undefined) {
    if (config.approvalPolicy === 'never') {
      options.permissionMode = 'dontAsk'
      policy.approvalMode = 'deny'
    } else if (config.approvalPolicy === 'on-request') {
      options.permissionMode = 'default'
    } else {
      diagnostics.push(unsupported('approvalPolicy', config.approvalPolicy, source))
      options.permissionMode = 'default'
    }
  }

  if (config.sandboxMode !== undefined) {
    policy.sandboxRequired = true
    policy.sandboxMode = config.sandboxMode
    options.sandbox = { enabled: true, failIfUnavailable: true }
    if (config.sandboxMode === 'danger-full-access') {
      diagnostics.push({
        level: 'error',
        code: 'unsafe',
        field: 'sandboxMode',
        source,
        message: 'danger-full-access is not mapped to unsandboxed Claude execution',
      })
    }
  }

  return { options, policy, diagnostics }
}

function isEffort(value: string): value is NonNullable<Options['effort']> {
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
}

function unsupported(field: string, value: string, source: string): ConfigDiagnostic {
  return {
    level: 'warning',
    code: 'unsupported',
    field,
    source,
    message: `Config value is not mapped to Claude SDK: ${field}=${value}`,
  }
}
