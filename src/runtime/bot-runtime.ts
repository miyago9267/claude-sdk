import { randomUUID } from 'node:crypto'

import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

import { extractAssistantBlocks, type ImageAttachment } from '../shared/messages.ts'
import {
  BotRegistry,
  buildBotOptions,
  type BotInvocationContext,
  type BotManifest,
} from './bots.ts'
import type { RuntimeConfig } from './config/index.ts'
import { DeliveryRouter } from './delivery.ts'
import type { ExecutionBoundary } from './execution.ts'
import { RuntimeEventBus } from './events.ts'
import { SessionRegistry } from './sessions.ts'
import type { RunHandlerContext, RunHandlerResult, RunResult, RunSupervisorOptions } from './supervisor.ts'
import { RunSupervisor } from './supervisor.ts'
import type { RunEnvelope, RunRequest } from './types.ts'
import type { ApprovalProvider } from './policy.ts'
import type { RuntimeEventSubscriber } from './events.ts'

export interface BotRuntimeRequest extends RunRequest {
  prompt: string
  systemPrompt?: string
  attachments?: ImageAttachment[]
  runtimeConfig?: RuntimeConfig
  sandboxed?: boolean
  deliveryTarget?: string
}

export interface BotRuntimeOptions {
  registry: BotRegistry
  sessions: SessionRegistry
  supervisor?: RunSupervisor
  supervisorOptions?: Omit<RunSupervisorOptions, 'registry' | 'events'>
  events?: RuntimeEventBus
  delivery?: DeliveryRouter
  approval?: ApprovalProvider
  query?: typeof sdkQuery
  execution?: ExecutionBoundary
}

export interface BotRunHandle {
  runId: string
  result: Promise<RunResult>
  cancel(): boolean
  interrupt(): Promise<boolean>
  setModel(model?: string): Promise<boolean>
  setPermissionMode(mode: Parameters<Query['setPermissionMode']>[0]): Promise<boolean>
  setMaxThinkingTokens(tokens?: number): Promise<boolean>
}

export class BotRuntime {
  private readonly registry: BotRegistry
  private readonly sessions: SessionRegistry
  private readonly supervisor: RunSupervisor
  private readonly events?: RuntimeEventBus
  private readonly delivery?: DeliveryRouter
  private readonly approval?: ApprovalProvider
  private readonly query: typeof sdkQuery
  private readonly execution?: ExecutionBoundary
  private readonly activeQueries = new Map<string, Query>()
  private readonly deliveredRuns = new Set<string>()

  constructor(options: BotRuntimeOptions) {
    this.registry = options.registry
    this.sessions = options.sessions
    this.events = options.events
    this.delivery = options.delivery
    this.approval = options.approval
    this.query = options.query ?? sdkQuery
    this.execution = options.execution
    this.supervisor = options.supervisor ?? new RunSupervisor({
      ...options.supervisorOptions,
      registry: options.sessions,
      ...(options.events ? { events: options.events } : {}),
    })
  }

  async run(request: BotRuntimeRequest): Promise<RunResult> {
    return this.start(request).result
  }

  start(request: BotRuntimeRequest): BotRunHandle {
    const manifest = this.registry.get(request.botId)
    if (!manifest) throw new Error(`unknown bot: ${request.botId}`)

    const idempotencyKey = request.idempotencyKey ?? `bot-runtime:${randomUUID()}`
    const effectiveRequest: RunRequest = {
      ...request,
      idempotencyKey,
      workspace: request.workspace ?? manifest.workspace,
      ...(request.budgetUSD !== undefined || manifest.budget?.perRunUSD === undefined
        ? {}
        : { budgetUSD: manifest.budget.perRunUSD }),
    }
    const supervisorResult = this.supervisor.submit(effectiveRequest, (context) =>
      this.executeTurn(manifest, request, context),
    )
    const run = this.supervisor.listRuns().find((candidate) => candidate.idempotencyKey === idempotencyKey)
    if (!run) throw new Error(`failed to create bot run: ${request.botId}`)

    return {
      runId: run.runId,
      result: supervisorResult.then(async (result) => {
        await this.deliverResult(request.deliveryTarget, result)
        return result
      }),
      cancel: () => this.supervisor.cancel(run.runId),
      interrupt: () => this.interrupt(run.runId),
      setModel: (model) => this.setModel(run.runId, model),
      setPermissionMode: (mode) => this.setPermissionMode(run.runId, mode),
      setMaxThinkingTokens: (tokens) => this.setMaxThinkingTokens(run.runId, tokens),
    }
  }

  getRun(runId: string) {
    return this.supervisor.getRun(runId)
  }

  subscribe(subscriber: RuntimeEventSubscriber): () => boolean {
    return this.events?.subscribe(subscriber) ?? (() => false)
  }

  cancel(runId: string): boolean {
    return this.supervisor.cancel(runId)
  }

  async interrupt(runId: string): Promise<boolean> {
    const activeQuery = this.activeQueries.get(runId)
    if (!activeQuery) return false
    await activeQuery.interrupt()
    return true
  }

  async setModel(runId: string, model?: string): Promise<boolean> {
    const activeQuery = this.activeQueries.get(runId)
    if (!activeQuery) return false
    await activeQuery.setModel(model)
    return true
  }

  async setPermissionMode(
    runId: string,
    mode: Parameters<Query['setPermissionMode']>[0],
  ): Promise<boolean> {
    const activeQuery = this.activeQueries.get(runId)
    if (!activeQuery) return false
    await activeQuery.setPermissionMode(mode)
    return true
  }

  async setMaxThinkingTokens(runId: string, tokens?: number): Promise<boolean> {
    const activeQuery = this.activeQueries.get(runId)
    if (!activeQuery) return false
    await activeQuery.setMaxThinkingTokens(tokens)
    return true
  }

  async shutdown(reason?: string): Promise<void> {
    await this.supervisor.shutdown(reason)
  }

  async repairAbandonedRuns(reason = 'process restart'): Promise<RunEnvelope[]> {
    return this.supervisor.repairAbandonedRuns(reason)
  }

  private async executeTurn(
    manifest: BotManifest,
    request: BotRuntimeRequest,
    context: RunHandlerContext,
  ): Promise<RunHandlerResult> {
    const execution = await this.execution?.prepare({
      botId: manifest.id,
      workspace: request.workspace ?? manifest.workspace,
      ...(request.sandboxed !== undefined ? { sandboxed: request.sandboxed } : {}),
      ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
    })
    try {
    const invocation: BotInvocationContext = {
      sessionKey: request.sessionKey,
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.sandboxed !== undefined ? { sandboxed: request.sandboxed } : {}),
      ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
    }
    const options = buildBotOptions(manifest, invocation, this.approval)
    if (request.systemPrompt !== undefined) options.systemPrompt = request.systemPrompt
    if (request.model) options.model = request.model
    if (execution) {
      options.cwd = execution.workspace
      if (execution.sandboxed) options.sandbox = { enabled: true, failIfUnavailable: true }
    } else if (request.workspace) options.cwd = request.workspace
    if (context.session.sdkSessionId) options.resume = context.session.sdkSessionId
    const queryAbortController = options.abortController ?? new AbortController()
    options.abortController = queryAbortController
    const abortQuery = () => queryAbortController.abort(context.signal.reason)
    context.signal.addEventListener('abort', abortQuery, { once: true })

    const activeQuery = this.query({ prompt: toQueryPrompt(request), options })
    this.activeQueries.set(context.run.runId, activeQuery)
    let resultMessage: SDKResultMessage | undefined
    let streamedText = ''

    try {
      for await (const message of activeQuery) {
        await this.publishMessageEvents(context.run.runId, message)
        if (message.type === 'assistant') {
          streamedText += extractAssistantBlocks(message as SDKAssistantMessage).text
        }
        if (message.type === 'result') {
          resultMessage = message as SDKResultMessage
          break
        }
      }
    } finally {
      if (this.activeQueries.get(context.run.runId) === activeQuery) {
        this.activeQueries.delete(context.run.runId)
      }
      context.signal.removeEventListener('abort', abortQuery)
      activeQuery.close()
    }

    if (!resultMessage) throw new Error('Claude query ended without a result')
    if (resultMessage.is_error) {
      const detail = 'result' in resultMessage && typeof resultMessage.result === 'string'
        ? resultMessage.result
        : `Claude query failed: ${resultMessage.subtype}`
      throw new Error(detail)
    }

    await this.sessions.update(context.session.sessionKey, {
      sdkSessionId: resultMessage.session_id,
      workspace: execution?.workspace ?? request.workspace ?? manifest.workspace,
    })
    return {
      output: resultMessage.result || streamedText,
      costUSD: resultMessage.total_cost_usd,
    }
    } finally {
      await execution?.release()
    }
  }

  private async publishMessageEvents(runId: string, message: SDKMessage): Promise<void> {
    if (!this.events) return
    const base = { eventId: randomUUID(), runId, occurredAt: new Date().toISOString() }
    if (message.type === 'assistant') {
      const blocks = extractAssistantBlocks(message as SDKAssistantMessage)
      if (blocks.text) await this.events.publish({ ...base, type: 'assistant.delta', text: blocks.text })
      for (const tool of blocks.toolUses) {
        await this.events.publish({
          ...base,
          eventId: randomUUID(),
          type: 'tool.started',
          toolName: tool.name,
        })
      }
    }
  }

  private async deliverResult(target: string | undefined, result: RunResult): Promise<void> {
    if (!target || !this.delivery) return
    if (this.deliveredRuns.has(result.runId)) return
    this.deliveredRuns.add(result.runId)
    const run = this.supervisor.getRun(result.runId)
    if (!run) return

    if (result.status === 'completed') {
      await this.delivery.deliver(target, {
        eventId: randomUUID(),
        runId: result.runId,
        occurredAt: new Date().toISOString(),
        type: 'run.completed',
        run,
        ...(result.output !== undefined ? { output: result.output } : {}),
      })
    } else if (result.status === 'failed') {
      await this.delivery.deliver(target, {
        eventId: randomUUID(),
        runId: result.runId,
        occurredAt: new Date().toISOString(),
        type: 'run.failed',
        run,
        error: result.error ?? 'bot run failed',
      })
    }
  }
}

function toQueryPrompt(request: BotRuntimeRequest): string | AsyncIterable<SDKUserMessage> {
  if (!request.attachments?.length) return request.prompt
  return (async function* (): AsyncGenerator<SDKUserMessage> {
    const content = [
      ...(request.prompt ? [{ type: 'text', text: request.prompt }] : []),
      ...request.attachments!.map((attachment) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: attachment.mediaType,
          data: attachment.base64,
        },
      })),
    ]
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage
  })()
}
