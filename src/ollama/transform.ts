/**
 * Pure transformers between Ollama wire format and the shared HistoryMessage
 * primitives. The server module orchestrates these into request/response flow.
 */

import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'

import {
  buildPromptFromHistory,
  type AssistantBlocks,
  type HistoryMessage,
  type PromptBuildResult,
} from '../shared/messages.ts'
import type {
  OllamaChatFrame,
  OllamaMessage,
  OllamaModelTag,
  OllamaShowResponse,
  OllamaTagsResponse,
  OllamaToolCall,
} from './types.ts'

// 'tools' advertised so the model shows up in Copilot's Agent picker. The
// transport layer drops tool_use blocks (see fromAssistantMessage), so Copilot
// never sees OpenAI tool_calls and falls back to treating the response as
// plain chat text. Net effect: Agent UI is reachable, model still self-runs
// SDK built-in tools against the bridge cwd, but the Agent UI's inline tool
// review surface stays empty (it has nothing to review).
export const OLLAMA_CAPABILITIES = ['completion', 'tools', 'thinking', 'vision']

const DEFAULT_DETAILS = {
  parent_model: '',
  format: 'gguf',
  family: 'claude',
  families: ['claude'],
  parameter_size: 'unknown',
  quantization_level: 'F16',
} as const

/** Convert an Ollama messages array into the generic history representation. */
export function ollamaMessagesToHistory(messages: OllamaMessage[]): HistoryMessage[] {
  return messages.map((m) => {
    const base: HistoryMessage = { role: m.role, content: m.content ?? null }
    if (m.tool_calls?.length) {
      base.toolCalls = m.tool_calls.map((tc) => ({
        name: tc.function.name,
        arguments: tc.function.arguments,
      }))
    }
    if (m.tool_name) base.toolName = m.tool_name
    if (m.images?.length) base.images = m.images
    return base
  })
}

/** Wrapper for buildPromptFromHistory keyed by Ollama messages directly. */
export function buildPromptFromOllamaMessages(messages: OllamaMessage[]): PromptBuildResult {
  return buildPromptFromHistory(ollamaMessagesToHistory(messages))
}

/**
 * Map Claude SDK stop_reason to Ollama done_reason. Ollama only formally
 * defines `stop`, `load`, `unload` — we extend with `length` because that's
 * what most Ollama-compatible clients (Copilot included) actually parse.
 */
export function mapDoneReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'length'
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
    case 'refusal':
    default:
      return 'stop'
  }
}

export interface FrameDurations {
  totalDurationNs?: number
  loadDurationNs?: number
  promptEvalDurationNs?: number
  evalDurationNs?: number
}

/**
 * Build the terminal `done: true` frame for non-streaming responses (and the
 * last NDJSON line for streaming responses). The `message` field carries the
 * fully accumulated assistant text + tool_calls; intermediate streaming frames
 * carry partial deltas instead.
 */
export function buildDoneFrame(args: {
  model: string
  blocks: AssistantBlocks
  thinking?: string
  result: SDKResultMessage | null
  durations?: FrameDurations
}): OllamaChatFrame {
  const { model, blocks, thinking, result, durations } = args
  const message: OllamaMessage = { role: 'assistant', content: blocks.text }
  if (thinking) message.thinking = thinking
  if (blocks.toolUses.length) message.tool_calls = blocks.toolUses.map(toOllamaToolCall)

  const usage = extractUsage(result)
  return {
    model,
    created_at: nowIso(),
    message,
    done: true,
    done_reason: mapDoneReason(blocks.stopReason),
    total_duration: durations?.totalDurationNs,
    load_duration: durations?.loadDurationNs,
    prompt_eval_count: usage.promptTokens,
    prompt_eval_duration: durations?.promptEvalDurationNs,
    eval_count: usage.evalTokens,
    eval_duration: durations?.evalDurationNs,
  }
}

/** Build a streaming partial frame carrying a text delta. */
export function buildTextDeltaFrame(model: string, delta: string): OllamaChatFrame {
  return {
    model,
    created_at: nowIso(),
    message: { role: 'assistant', content: delta },
    done: false,
  }
}

/** Build a streaming frame announcing a fully-formed tool call. */
export function buildToolCallFrame(
  model: string,
  toolUse: { name: string; input: Record<string, unknown> },
): OllamaChatFrame {
  return {
    model,
    created_at: nowIso(),
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: toolUse.name, arguments: toolUse.input } }],
    },
    done: false,
  }
}

/** Build a streaming frame carrying a thinking delta. */
export function buildThinkingDeltaFrame(model: string, delta: string): OllamaChatFrame {
  return {
    model,
    created_at: nowIso(),
    message: { role: 'assistant', content: '', thinking: delta },
    done: false,
  }
}

function toOllamaToolCall(tu: { name: string; input: Record<string, unknown> }): OllamaToolCall {
  return { function: { name: tu.name, arguments: tu.input } }
}

interface UsageNumbers {
  promptTokens: number
  evalTokens: number
}

function extractUsage(result: SDKResultMessage | null): UsageNumbers {
  if (!result || !('usage' in result) || !result.usage) {
    return { promptTokens: 0, evalTokens: 0 }
  }
  const u = result.usage as Record<string, unknown>
  const inputTokens = Number(u.input_tokens ?? 0)
  const outputTokens = Number(u.output_tokens ?? 0)
  const cacheRead = Number(u.cache_read_input_tokens ?? 0)
  const cacheCreate = Number(u.cache_creation_input_tokens ?? 0)
  return {
    promptTokens: inputTokens + cacheRead + cacheCreate,
    evalTokens: outputTokens,
  }
}

/** Build the `/api/tags` payload from a list of advertised model IDs. */
export function buildTagsResponse(modelIds: string[], modifiedAt = nowIso()): OllamaTagsResponse {
  return {
    models: modelIds.map((id) => buildModelTag(id, modifiedAt)),
  }
}

function buildModelTag(id: string, modifiedAt: string): OllamaModelTag {
  return {
    name: id,
    model: id,
    modified_at: modifiedAt,
    size: 0,
    digest: pseudoDigest(id),
    details: { ...DEFAULT_DETAILS, parameter_size: parameterSizeFor(id) },
  }
}

/**
 * Build the `/api/show` payload. Copilot's ollamaProvider reads:
 *   - `capabilities` (string[]) → toggles vision / tool_calls UI
 *   - `model_info['general.architecture']` → key prefix for context length
 *   - `model_info[`${arch}.context_length`]` → max_context_window_tokens
 *   - `model_info['general.basename']` → human-readable name in the picker
 * Missing fields fall back to defaults (32K window, raw model id as name).
 */
export function buildShowResponse(modelId: string): OllamaShowResponse {
  const arch = 'claude'
  return {
    modelfile: `# Bridged via @miyago/claude-sdk\nFROM ${modelId}\n`,
    parameters: '',
    template: '{{ .Prompt }}',
    details: { ...DEFAULT_DETAILS, parameter_size: parameterSizeFor(modelId) },
    model_info: {
      'general.architecture': arch,
      'general.basename': humanNameFor(modelId),
      [`${arch}.context_length`]: contextLengthFor(modelId),
    },
    capabilities: [...OLLAMA_CAPABILITIES],
  }
}

function parameterSizeFor(modelId: string): string {
  if (modelId.includes('opus')) return '500B+'
  if (modelId.includes('sonnet')) return '200B'
  if (modelId.includes('haiku')) return '70B'
  return 'unknown'
}

const ONE_MILLION_CTX = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5'])

function contextLengthFor(modelId: string): number {
  // Current flagship tiers ship the 1M-token window; older tiers stay at 200K.
  if (ONE_MILLION_CTX.has(modelId)) return 1_000_000
  if (modelId.includes('claude')) return 200_000
  return 200_000
}

function humanNameFor(modelId: string): string {
  const map: Record<string, string> = {
    'claude-opus-4-8': 'Claude Opus 4.8 (1M)',
    'claude-opus-4-7': 'Claude Opus 4.7 (1M)',
    'claude-opus-4-6': 'Claude Opus 4.6',
    'claude-sonnet-4-6': 'Claude Sonnet 4.6',
    'claude-haiku-4-5': 'Claude Haiku 4.5',
    'claude-fable-5': 'Claude Fable 5 (1M)',
  }
  return map[modelId] ?? modelId
}

function pseudoDigest(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0
  const hex = (h >>> 0).toString(16).padStart(8, '0')
  return `sha256:${hex.repeat(8)}`
}

function nowIso(): string {
  return new Date().toISOString()
}
