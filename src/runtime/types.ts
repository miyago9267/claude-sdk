export type RunTrigger = 'message' | 'cron' | 'webhook' | 'heartbeat' | 'job'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface RunSource {
  platform?: string
  accountId?: string
  channelId?: string
  threadId?: string
  messageId?: string
}

export interface RunEnvelope {
  runId: string
  botId: string
  sessionKey: string
  trigger: RunTrigger
  status: RunStatus
  attempt: number
  createdAt: string
  updatedAt: string
  idempotencyKey?: string
  userId?: string
  source?: RunSource
  parentRunId?: string
  model?: string
  provider?: string
  workspace?: string
  policyProfile?: string
  budgetUSD?: number
  error?: string
}

export interface RunRequest {
  botId: string
  sessionKey: string
  trigger: RunTrigger
  idempotencyKey?: string
  userId?: string
  source?: RunSource
  parentRunId?: string
  model?: string
  provider?: string
  workspace?: string
  policyProfile?: string
  budgetUSD?: number
}

export type SessionStatus = 'active' | 'archived' | 'expired'

export interface SessionRecord {
  sessionKey: string
  botId: string
  status: SessionStatus
  createdAt: string
  updatedAt: string
  sdkSessionId?: string
  workspace?: string
  metadata?: Record<string, unknown>
}
