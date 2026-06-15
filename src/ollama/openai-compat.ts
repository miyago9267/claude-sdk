/**
 * OpenAI Chat Completions wire format support for the Ollama bridge.
 *
 * Counter-intuitive but necessary: VS Code Copilot's OllamaLMProvider extends
 * AbstractOpenAICompatibleLMProvider, so chat traffic actually flows through
 * `${baseUrl}/v1/chat/completions` (SSE) — only the model discovery dance
 * (/api/tags, /api/show) uses Ollama-native shapes. We host both protocol
 * surfaces in the same Hono server.
 */

import type {
  SDKAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import {
  buildPromptFromHistory,
  detectImageMediaType,
  extractAssistantBlocks,
  type HistoryMessage,
  type HistoryToolCall,
  type ImageAttachment,
  type PromptBuildResult,
} from '../shared/messages.ts'

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAIMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface OpenAIMessage {
  role: OpenAIMessageRole
  content: string | OpenAIContentPart[] | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAIToolDefinition {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  temperature?: number
  top_p?: number
  max_tokens?: number
  tools?: OpenAIToolDefinition[]
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  stop?: string | string[]
  user?: string
}

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null

export interface OpenAIChatCompletionUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OpenAIChatCompletionChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: OpenAIFinishReason
}

export interface OpenAIChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChatCompletionChoice[]
  usage: OpenAIChatCompletionUsage
}

export interface OpenAIChatCompletionStreamDelta {
  role?: 'assistant'
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: { name?: string; arguments?: string }
  }>
}

export interface OpenAIChatCompletionStreamChoice {
  index: number
  delta: OpenAIChatCompletionStreamDelta
  finish_reason: OpenAIFinishReason
}

export interface OpenAIChatCompletionChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: OpenAIChatCompletionStreamChoice[]
  usage?: OpenAIChatCompletionUsage
}

export interface OpenAIModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: string
}

export interface OpenAIModelsResponse {
  object: 'list'
  data: OpenAIModelEntry[]
}

/**
 * Convert OpenAI messages to the protocol-agnostic HistoryMessage shape.
 * Image content parts (data URL or http URL) become base64 entries on the
 * `images` field; non-base64 image_url values are dropped (we can't fetch
 * remote URLs synchronously from inside the SDK pipeline).
 */
export function openAIMessagesToHistory(messages: OpenAIMessage[]): HistoryMessage[] {
  return messages.map((m) => {
    const text = stringifyContent(m.content)
    const images = collectImagesFromContent(m.content)
    const hist: HistoryMessage = { role: m.role, content: text }
    if (images.length) hist.images = images
    if (m.tool_calls?.length) {
      hist.toolCalls = m.tool_calls.map(toHistoryToolCall)
    }
    if (m.tool_call_id) hist.toolCallId = m.tool_call_id
    return hist
  })
}

function toHistoryToolCall(call: OpenAIToolCall): HistoryToolCall {
  let parsedArgs: unknown = call.function.arguments
  try {
    parsedArgs = JSON.parse(call.function.arguments)
  } catch {
    /* keep raw string */
  }
  return { id: call.id, name: call.function.name, arguments: parsedArgs }
}

export function buildPromptFromOpenAIMessages(messages: OpenAIMessage[]): PromptBuildResult {
  return buildPromptFromHistory(openAIMessagesToHistory(messages))
}

function stringifyContent(content: OpenAIMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

function collectImagesFromContent(content: OpenAIMessage['content']): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const p of content) {
    if (p.type !== 'image_url') continue
    const url = p.image_url?.url ?? ''
    if (url.startsWith('data:image/')) out.push(url)
  }
  return out
}

/** Pull the final-turn images out of a HistoryMessage[] in ImageAttachment shape. */
export function attachmentsFromHistory(messages: HistoryMessage[]): ImageAttachment[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (!m.images?.length) return []
    return m.images.map((b) => ({ base64: b, mediaType: detectImageMediaType(b) }))
  }
  return []
}

export function mapStopReason(stopReason: string | null | undefined): OpenAIFinishReason {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    case 'refusal':
      return 'content_filter'
    default:
      return stopReason ? 'stop' : null
  }
}

export interface NonStreamingExtraction {
  text: string
  toolCalls: OpenAIToolCall[]
  finishReason: OpenAIFinishReason
}

export function extractAssistantContent(msg: SDKAssistantMessage): NonStreamingExtraction {
  const blocks = extractAssistantBlocks(msg)
  const toolCalls: OpenAIToolCall[] = blocks.toolUses.map((tu, i) => ({
    id: tu.id ?? `call_${i}`,
    type: 'function',
    function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
  }))
  return {
    text: blocks.text,
    toolCalls,
    finishReason: mapStopReason(blocks.stopReason),
  }
}

export function buildNonStreamingResponse(args: {
  id: string
  model: string
  assistantMsgs: SDKAssistantMessage[]
  result: SDKResultMessage | null
}): OpenAIChatCompletionResponse {
  const { id, model, assistantMsgs, result } = args
  const lastAssistant = assistantMsgs[assistantMsgs.length - 1]
  const extraction = lastAssistant
    ? extractAssistantContent(lastAssistant)
    : { text: '', toolCalls: [], finishReason: null as OpenAIFinishReason }

  const choice: OpenAIChatCompletionChoice = {
    index: 0,
    message: {
      role: 'assistant',
      content: extraction.text || null,
      ...(extraction.toolCalls.length ? { tool_calls: extraction.toolCalls } : {}),
    },
    finish_reason: extraction.finishReason ?? 'stop',
  }

  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [choice],
    usage: extractUsage(result),
  }
}

/**
 * Surface an upstream failure verbatim. When the SDK turn ends with
 * `is_error` and produced no assistant text — e.g. the requested model isn't
 * accessible on this account — we return the upstream message so the harness
 * sees the real reason instead of an empty 200. Returns null on success, or
 * when an errored turn still produced assistant text (we'd rather return that).
 */
export function resultErrorMessage(
  result: SDKResultMessage | null,
  assistantText: string,
): string | null {
  if (!result || assistantText.trim() !== '') return null
  const r = result as unknown as Record<string, unknown>
  if (!r.is_error) return null
  if (typeof r.result === 'string' && r.result.trim()) return r.result
  const subtype = typeof r.subtype === 'string' ? r.subtype : 'unknown'
  return `upstream error (${subtype})`
}

export function extractUsage(result: SDKResultMessage | null): OpenAIChatCompletionUsage {
  if (!result || !('usage' in result) || !result.usage) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  const u = result.usage as Record<string, unknown>
  const inputTokens = Number(u.input_tokens ?? 0)
  const outputTokens = Number(u.output_tokens ?? 0)
  const cacheRead = Number(u.cache_read_input_tokens ?? 0)
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0)
  const promptTokens = inputTokens + cacheRead + cacheCreate
  return {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
  }
}

/**
 * SSE chunk converter. Maps Claude SDK partial-message stream events to
 * OpenAI chat.completion.chunk frames, keeping per-tool-use index state so
 * input_json_delta fragments concatenate to the correct tool_call.
 */
export class StreamingChunkConverter {
  private id: string
  private model: string
  private toolCallIndexByBlock = new Map<number, number>()
  private nextToolCallIndex = 0
  private finishReason: OpenAIFinishReason = null
  private startedRole = false
  /**
   * Tracks whether the *current* assistant turn has already emitted content
   * via the stream_event partial path. Resets on each fromAssistantMessage()
   * call (i.e. at every SDK assistant message boundary). Used to decide
   * whether the assistant-message fallback should fire — we never want both
   * paths to emit the same content.
   */
  private turnEmittedFromStream = false

  constructor(id: string, model: string) {
    this.id = id
    this.model = model
  }

  /** True if the current turn already emitted content via stream_event. */
  hasEmittedFromStream(): boolean {
    return this.turnEmittedFromStream
  }

  buildRoleChunk(): OpenAIChatCompletionChunk {
    this.startedRole = true
    return this.shell([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
  }

  /**
   * Fallback: turn a fully-formed SDKAssistantMessage into chunk(s). Patched
   * V2 sessions don't fire stream_event partials — they dispatch complete
   * assistant messages, one per agent turn. We synthesise the equivalent
   * delta chunks. Multi-turn agent loops emit several assistant messages, all
   * of which we want to forward (the per-turn flag resets at the end here).
   * Skipped if the current turn already has stream_event content (avoids
   * double-emit on dual-channel SDKs).
   */
  fromAssistantMessage(msg: SDKAssistantMessage): OpenAIChatCompletionChunk[] {
    if (this.turnEmittedFromStream) {
      this.turnEmittedFromStream = false
      return []
    }
    const blocks = extractAssistantContent(msg)
    const chunks: OpenAIChatCompletionChunk[] = []
    if (blocks.text) {
      chunks.push(
        this.shell([{ index: 0, delta: { content: blocks.text }, finish_reason: null }]),
      )
    }
    // tool_calls intentionally dropped (chat-only — see ADR-3). No placeholder
    // either: agent loops over many turns, often with intermediate "do work,
    // don't talk" turns. A placeholder per silent turn would spam the client
    // with `(Model attempted to use a tool; bridge is chat-only.)` lines and
    // bury the model's actual narrative. The agent loop's final turn almost
    // always has text — if the entire loop produces zero text the client
    // gets an empty response, which is the honest outcome.
    if (blocks.finishReason) {
      // Drop the tool_calls finish reason since we drop the tool_calls.
      this.finishReason = blocks.finishReason === 'tool_calls' ? 'stop' : blocks.finishReason
    }
    this.turnEmittedFromStream = false
    return chunks
  }

  fromStreamEvent(event: BetaRawMessageStreamEvent): OpenAIChatCompletionChunk | null {
    if (event.type === 'message_start') {
      if (this.startedRole) return null
      return this.buildRoleChunk()
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'tool_use') {
        // Chat-only bridge: drop tool_use blocks. See fromAssistantMessage
        // for the same rationale. Track index so input_json_delta fragments
        // for this block also get dropped.
        this.toolCallIndexByBlock.set(event.index, -1)
      }
      return null
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta.type === 'text_delta') {
        this.turnEmittedFromStream = true
        return this.shell([
          { index: 0, delta: { content: delta.text }, finish_reason: null },
        ])
      }
      if (delta.type === 'input_json_delta') {
        // Chat-only bridge: tool_use accumulators are no-ops.
        return null
      }
      return null
    }

    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason as string | null | undefined
      const mapped = mapStopReason(stopReason)
      // tool_calls finish reason flips to 'stop' since we drop tool_use.
      this.finishReason = mapped === 'tool_calls' ? 'stop' : mapped
      return null
    }

    return null
  }

  buildFinishChunk(fallbackReason: OpenAIFinishReason = 'stop'): OpenAIChatCompletionChunk {
    return this.shell([
      { index: 0, delta: {}, finish_reason: this.finishReason ?? fallbackReason },
    ])
  }

  buildUsageChunk(result: SDKResultMessage): OpenAIChatCompletionChunk {
    const chunk = this.shell([])
    chunk.usage = extractUsage(result)
    return chunk
  }

  private shell(choices: OpenAIChatCompletionChunk['choices']): OpenAIChatCompletionChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices,
    }
  }
}
