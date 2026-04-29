/**
 * Pure transformers between OpenAI Chat Completions wire format and Claude SDK
 * messages. No I/O, no SDK calls — just shape conversion. The server module
 * orchestrates these into a streaming pipeline.
 */

import type {
  SDKAssistantMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import type {
  OpenAIChatCompletionChoice,
  OpenAIChatCompletionChunk,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIChatCompletionUsage,
  OpenAIFinishReason,
  OpenAIMessage,
  OpenAIToolCall,
} from './types.js'

export interface PromptBuildResult {
  systemPrompt: string | null
  prompt: string
}

/**
 * Flatten an OpenAI messages array into a single prompt string suitable for
 * one-shot V2 session.send(). System messages are extracted separately so the
 * caller can pass them as session systemPrompt option.
 *
 * Conversation history (assistant turns, tool calls, tool results) is rendered
 * as plain-text transcript blocks. This is loss-of-fidelity but works for the
 * stateless adapter pattern: Copilot replays full history on each request, so
 * the model gets the same context the API contract promises.
 */
export function buildPromptFromOpenAIMessages(
  messages: OpenAIMessage[],
): PromptBuildResult {
  const systemParts: string[] = []
  const transcript: string[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = stringifyContent(msg.content)
      if (text) systemParts.push(text)
      continue
    }

    if (msg.role === 'user') {
      const text = stringifyContent(msg.content)
      if (text) transcript.push(`<user>\n${text}\n</user>`)
      continue
    }

    if (msg.role === 'assistant') {
      const parts: string[] = []
      const text = stringifyContent(msg.content)
      if (text) parts.push(text)
      if (msg.tool_calls?.length) {
        for (const call of msg.tool_calls) {
          parts.push(
            `[tool_call name="${call.function.name}" id="${call.id}"]${call.function.arguments}[/tool_call]`,
          )
        }
      }
      if (parts.length) transcript.push(`<assistant>\n${parts.join('\n')}\n</assistant>`)
      continue
    }

    if (msg.role === 'tool') {
      const text = stringifyContent(msg.content)
      transcript.push(
        `<tool_result tool_call_id="${msg.tool_call_id ?? 'unknown'}">\n${text}\n</tool_result>`,
      )
      continue
    }
  }

  const lastUserIdx = findLastIndex(messages, (m) => m.role === 'user')
  const isOnlyOneUserTurn = transcript.length === 1 && lastUserIdx >= 0

  let prompt: string
  if (isOnlyOneUserTurn) {
    prompt = stringifyContent(messages[lastUserIdx]!.content)
  } else {
    prompt = transcript.join('\n\n')
  }

  return {
    systemPrompt: systemParts.length ? systemParts.join('\n\n') : null,
    prompt,
  }
}

function stringifyContent(content: OpenAIMessage['content']): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i
  return -1
}

/** Translate Claude stop_reason to OpenAI finish_reason. */
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

/**
 * Walk a SDKAssistantMessage's content blocks and pull out plain text plus
 * tool_use calls in OpenAI shape. Used for non-streaming responses where we
 * accumulate the full message before serialising.
 */
export function extractAssistantContent(msg: SDKAssistantMessage): NonStreamingExtraction {
  const beta = msg.message
  const blocks = Array.isArray(beta.content) ? beta.content : []
  let text = ''
  const toolCalls: OpenAIToolCall[] = []

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if ((block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') text += t
    } else if ((block as { type?: string }).type === 'tool_use') {
      const b = block as { id?: string; name?: string; input?: unknown }
      toolCalls.push({
        id: b.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: b.name ?? 'unknown',
          arguments: JSON.stringify(b.input ?? {}),
        },
      })
    }
  }

  return {
    text,
    toolCalls,
    finishReason: mapStopReason(beta.stop_reason),
  }
}

/** Build a complete (non-streaming) OpenAI chat completion response. */
export function buildNonStreamingResponse(args: {
  id: string
  model: string
  request: OpenAIChatCompletionRequest
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

function extractUsage(result: SDKResultMessage | null): OpenAIChatCompletionUsage {
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
 * Streaming converter: keeps mapping state between Claude content_block index
 * and OpenAI tool_calls index so input_json_delta fragments concatenate to the
 * right call.
 */
export class StreamingChunkConverter {
  private id: string
  private model: string
  private toolCallIndexByBlock = new Map<number, number>()
  private nextToolCallIndex = 0
  private finishReason: OpenAIFinishReason = null
  private startedRole = false

  constructor(id: string, model: string) {
    this.id = id
    this.model = model
  }

  /** First chunk to emit on stream open: role marker. */
  buildRoleChunk(): OpenAIChatCompletionChunk {
    this.startedRole = true
    return this.shell([
      {
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      },
    ])
  }

  /**
   * Convert a Claude SDK partial-assistant stream event into zero-or-one
   * OpenAI chunks. Returns null if the event has no observable side effect.
   */
  fromStreamEvent(event: BetaRawMessageStreamEvent): OpenAIChatCompletionChunk | null {
    if (event.type === 'message_start') {
      if (this.startedRole) return null
      return this.buildRoleChunk()
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block.type === 'tool_use') {
        const oaiIdx = this.nextToolCallIndex++
        this.toolCallIndexByBlock.set(event.index, oaiIdx)
        return this.shell([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: oaiIdx,
                  id: block.id,
                  type: 'function',
                  function: { name: block.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ])
      }
      return null
    }

    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta.type === 'text_delta') {
        return this.shell([
          {
            index: 0,
            delta: { content: delta.text },
            finish_reason: null,
          },
        ])
      }
      if (delta.type === 'input_json_delta') {
        const oaiIdx = this.toolCallIndexByBlock.get(event.index)
        if (oaiIdx == null) return null
        return this.shell([
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: oaiIdx,
                  function: { arguments: delta.partial_json },
                },
              ],
            },
            finish_reason: null,
          },
        ])
      }
      return null
    }

    if (event.type === 'message_delta') {
      const stopReason = event.delta?.stop_reason as string | null | undefined
      this.finishReason = mapStopReason(stopReason)
      return null
    }

    return null
  }

  /** Last chunk: finish_reason. Caller should follow with `data: [DONE]`. */
  buildFinishChunk(fallbackReason: OpenAIFinishReason = 'stop'): OpenAIChatCompletionChunk {
    return this.shell([
      {
        index: 0,
        delta: {},
        finish_reason: this.finishReason ?? fallbackReason,
      },
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
