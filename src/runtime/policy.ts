import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'

export type ToolDecision =
  | 'allow'
  | 'deny'
  | 'ask-human'
  | 'allow-once'
  | 'allow-for-session'
  | 'require-sandbox'

export interface ToolPolicyRequest {
  botId: string
  sessionKey: string
  toolName: string
  input: Record<string, unknown>
  userId?: string
  environment?: string
  workspace?: string
  sandboxed?: boolean
  blockedPath?: string
}

export interface ToolPolicyRule {
  tool: string
  decision: ToolDecision
  botId?: string
  environment?: string
  reason?: string
}

export interface ToolPolicyConfig {
  defaultDecision: ToolDecision
  rules: ToolPolicyRule[]
}

export interface ToolPolicyResult {
  decision: Exclude<ToolDecision, 'require-sandbox'>
  reason: string
  rule?: ToolPolicyRule
}

export interface ApprovalRequest extends ToolPolicyRequest {
  reason: string
  signal: AbortSignal
}

export type ApprovalProvider = (request: ApprovalRequest) => Promise<'allow' | 'deny'>

const matches = (pattern: string, value: string): boolean => {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const [prefix, suffix] = pattern.split('*', 2)
  return value.startsWith(prefix ?? '') && value.endsWith(suffix ?? '')
}

export class ToolPolicyEngine {
  private readonly config: ToolPolicyConfig

  constructor(config?: Partial<ToolPolicyConfig>) {
    this.config = {
      defaultDecision: config?.defaultDecision ?? 'deny',
      rules: config?.rules ?? [],
    }
  }

  evaluate(request: ToolPolicyRequest): ToolPolicyResult {
    const rule = this.config.rules.find(
      (candidate) =>
        matches(candidate.tool, request.toolName) &&
        (candidate.botId === undefined || candidate.botId === request.botId) &&
        (candidate.environment === undefined || candidate.environment === request.environment),
    )
    const decision = rule?.decision ?? this.config.defaultDecision
    if (decision === 'require-sandbox' && !request.sandboxed) {
      return { decision: 'deny', reason: 'sandbox is required', ...(rule ? { rule } : {}) }
    }
    if (decision === 'require-sandbox') {
      return { decision: 'allow', reason: rule?.reason ?? 'sandboxed tool allowed', rule }
    }
    return {
      decision,
      reason: rule?.reason ?? `policy decision: ${decision}`,
      ...(rule ? { rule } : {}),
    }
  }

  createCanUseTool(
    context: Omit<ToolPolicyRequest, 'toolName' | 'input'>,
    approval?: ApprovalProvider,
  ): CanUseTool {
    return async (toolName, input, options) => {
      const request = { ...context, toolName, input }
      const result = this.evaluate(request)
      if (result.decision === 'allow' || result.decision === 'allow-once' || result.decision === 'allow-for-session') {
        return { behavior: 'allow' }
      }
      if (result.decision === 'ask-human' && approval && !options.signal.aborted) {
        const decision = await approval({ ...request, reason: result.reason, signal: options.signal })
        if (decision === 'allow') return { behavior: 'allow' }
      }
      return { behavior: 'deny', message: result.reason, interrupt: false }
    }
  }
}
