import { randomUUID } from 'node:crypto'

import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

import { extractAssistantBlocks } from '../shared/messages.ts'
import {
  BotRegistry,
  buildBotOptions,
  type BotInvocationContext,
  type BotManifest,
} from './bots.ts'
import type { RuntimeConfig } from './config/index.ts'
import { DeliveryRouter } from './delivery.ts'
import { RuntimeEventBus } from './events.ts'
import { SessionRegistry } from './sessions.ts'
import type { RunHandlerContext, RunHandlerResult, RunResult, RunSupervisorOptions } from './supervisor.ts'
import { RunSupervisor } from './supervisor.ts'
import type { RunRequest } from './types.ts'
import type { ApprovalProvider } from './policy.ts'

export interface BotRuntimeRequest extends RunRequest {
  prompt: string
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
}

export class BotRuntime {
  private readonly registry: BotRegistry
  private readonly sessions: SessionRegistry
  private readonly supervisor: RunSupervisor
  private readonly events?: RuntimeEventBus
  private readonly delivery?: DeliveryRouter
  private readonly approval?: ApprovalProvider
  private readonly query: typeof sdkQuery

  constructor(options: BotRuntimeOptions) {
    this.registry = options.registry
    this.sessions = options.sessions
    this.events = options.events
    this.delivery = options.delivery
    this.approval = options.approval
    this.query = options.query ?? sdkQuery
    this.supervisor = options.supervisor ?? new RunSupervisor({
      ...options.supervisorOptions,
      registry: options.sessions,
      ...(options.events ? { events: options.events } : {}),
    })
  }

  async run(request: BotRuntimeRequest): Promise<RunResult> {
    const manifest = this.registry.get(request.botId)
    if (!manifest) throw new Error(`unknown bot: ${request.botId}`)

    const effectiveRequest: RunRequest = {
      ...request,
      workspace: request.workspace ?? manifest.workspace,
      ...(request.budgetUSD !== undefined || manifest.budget?.perRunUSD === undefined
        ? {}
        : { budgetUSD: manifest.budget.perRunUSD }),
    }
    const result = await this.supervisor.submit(effectiveRequest, (context) =>
      this.executeTurn(manifest, request, context),
    )

    await this.deliverResult(request.deliveryTarget, result)
    return result
  }

  getRun(runId: string) {
    return this.supervisor.getRun(runId)
  }

  cancel(runId: string): boolean {
    return this.supervisor.cancel(runId)
  }

  async shutdown(reason?: string): Promise<void> {
    await this.supervisor.shutdown(reason)
  }

  private async executeTurn(
    manifest: BotManifest,
    request: BotRuntimeRequest,
    context: RunHandlerContext,
  ): Promise<RunHandlerResult> {
    const invocation: BotInvocationContext = {
      sessionKey: request.sessionKey,
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.sandboxed !== undefined ? { sandboxed: request.sandboxed } : {}),
      ...(request.runtimeConfig ? { runtimeConfig: request.runtimeConfig } : {}),
    }
    const options = buildBotOptions(manifest, invocation, this.approval)
    if (context.session.sdkSessionId) options.resume = context.session.sdkSessionId
    const queryAbortController = options.abortController ?? new AbortController()
    options.abortController = queryAbortController
    const abortQuery = () => queryAbortController.abort(context.signal.reason)
    context.signal.addEventListener('abort', abortQuery, { once: true })

    const activeQuery = this.query({ prompt: request.prompt, options })
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
      workspace: manifest.workspace,
    })
    return {
      output: resultMessage.result || streamedText,
      costUSD: resultMessage.total_cost_usd,
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
