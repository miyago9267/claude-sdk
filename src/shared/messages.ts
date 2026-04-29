/**
 * Generic conversation history primitives shared across HTTP protocol adapters
 * (Ollama bridge today, room for OpenAI / Anthropic native / others tomorrow).
 *
 * Wire formats vary in trivia (tool args as string vs object, tool result keyed
 * by id vs name, SSE vs NDJSON envelopes), but they all need to:
 *   1. flatten a multi-turn message array into a Claude-friendly prompt string,
 *      with system prompts pulled aside;
 *   2. extract text + tool_use blocks from a SDK assistant message.
 *
 * This module owns those two operations as pure functions. Wire-format-specific
 * serialisation lives in each adapter sub-module.
 */

import type { SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk'

export type HistoryRole = 'system' | 'user' | 'assistant' | 'tool'

export interface HistoryToolCall {
  id?: string
  name: string
  arguments: unknown
}

export interface HistoryMessage {
  role: HistoryRole
  content?: string | null
  toolCalls?: HistoryToolCall[]
  toolName?: string
  toolCallId?: string
  /** Base64-encoded image payloads attached to this message (raw, no data URL prefix). */
  images?: string[]
}

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface ImageAttachment {
  base64: string
  mediaType: ImageMediaType
}

export interface PromptBuildResult {
  systemPrompt: string | null
  prompt: string
  /**
   * Images carried by the *final* user turn — these need to be sent as image
   * content blocks alongside the prompt text. Images on earlier turns are
   * replaced with text placeholders inside `prompt` (lossy by design: the
   * transcript flatten can't carry raw bytes).
   */
  attachments: ImageAttachment[]
}

/**
 * Flatten a HistoryMessage[] into a single prompt string suitable for one-shot
 * V2 session.send(). System messages are extracted separately; the caller
 * passes them as the session's systemPrompt option.
 *
 * If the only non-system message is a single user turn, return its raw content
 * verbatim (no transcript wrapping). Otherwise render assistant turns,
 * tool_calls and tool_results as XML-tagged transcript blocks.
 */
export function buildPromptFromHistory(messages: HistoryMessage[]): PromptBuildResult {
  const systemParts: string[] = []
  const transcript: string[] = []
  const lastUserIdx = findLastIndex(messages, (m) => m.role === 'user')

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    const isFinalUserTurn = i === lastUserIdx

    if (msg.role === 'system') {
      const text = stringifyContent(msg.content)
      if (text) systemParts.push(text)
      continue
    }

    if (msg.role === 'user') {
      const parts: string[] = []
      const text = stringifyContent(msg.content)
      if (text) parts.push(text)
      // Earlier-turn images: leave a placeholder so the model knows attachments
      // existed but the bytes are gone. Final-turn images are emitted as real
      // image content blocks by the caller, so no placeholder is needed there.
      if (msg.images?.length && !isFinalUserTurn) {
        for (let k = 0; k < msg.images.length; k++) {
          parts.push(`[image attachment ${k + 1} omitted from transcript]`)
        }
      }
      if (parts.length) transcript.push(`<user>\n${parts.join('\n')}\n</user>`)
      continue
    }

    if (msg.role === 'assistant') {
      const parts: string[] = []
      const text = stringifyContent(msg.content)
      if (text) parts.push(text)
      if (msg.toolCalls?.length) {
        for (const call of msg.toolCalls) {
          const id = call.id ? ` id="${call.id}"` : ''
          const args = serialiseArgs(call.arguments)
          parts.push(`[tool_call name="${call.name}"${id}]${args}[/tool_call]`)
        }
      }
      if (parts.length) transcript.push(`<assistant>\n${parts.join('\n')}\n</assistant>`)
      continue
    }

    if (msg.role === 'tool') {
      const text = stringifyContent(msg.content)
      const ident = toolResultIdentifier(msg)
      transcript.push(`<tool_result ${ident}>\n${text}\n</tool_result>`)
      continue
    }
  }

  const isOnlyOneUserTurn = transcript.length === 1 && lastUserIdx >= 0

  let prompt: string
  if (isOnlyOneUserTurn) {
    prompt = stringifyContent(messages[lastUserIdx]!.content)
  } else {
    prompt = transcript.join('\n\n')
  }

  const finalUserImages = lastUserIdx >= 0 ? messages[lastUserIdx]!.images ?? [] : []
  const attachments = finalUserImages.map((b) => ({ base64: b, mediaType: detectImageMediaType(b) }))

  return {
    systemPrompt: systemParts.length ? systemParts.join('\n\n') : null,
    prompt,
    attachments,
  }
}

/**
 * Sniff the media type from the first few base64 characters. Defaults to
 * image/png because that's what most screenshot tooling (VS Code Copilot
 * included) produces.
 */
export function detectImageMediaType(base64: string): ImageMediaType {
  const head = base64.replace(/^data:[^;]+;base64,/, '').slice(0, 12)
  if (head.startsWith('iVBOR')) return 'image/png'
  if (head.startsWith('/9j/')) return 'image/jpeg'
  if (head.startsWith('R0lGOD')) return 'image/gif'
  if (head.startsWith('UklGR')) return 'image/webp'
  return 'image/png'
}

/** Strip an optional `data:image/...;base64,` URL prefix, leaving raw base64. */
export function stripDataUrlPrefix(input: string): string {
  return input.replace(/^data:[^;]+;base64,/, '')
}

export interface ExtractedToolUse {
  id?: string
  name: string
  input: Record<string, unknown>
}

export interface AssistantBlocks {
  text: string
  toolUses: ExtractedToolUse[]
  stopReason: string | null
}

/**
 * Walk a SDK assistant message's content blocks, accumulating plain text and
 * tool_use blocks. The returned shape is wire-format agnostic — adapters map
 * it to their own envelope.
 */
export function extractAssistantBlocks(msg: SDKAssistantMessage): AssistantBlocks {
  const beta = msg.message
  const blocks = Array.isArray(beta.content) ? beta.content : []
  let text = ''
  const toolUses: ExtractedToolUse[] = []

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    const type = (block as { type?: string }).type
    if (type === 'text') {
      const t = (block as { text?: unknown }).text
      if (typeof t === 'string') text += t
    } else if (type === 'tool_use') {
      const b = block as { id?: string; name?: string; input?: unknown }
      toolUses.push({
        id: b.id,
        name: b.name ?? 'unknown',
        input: (b.input ?? {}) as Record<string, unknown>,
      })
    }
  }

  const stopReason =
    typeof beta.stop_reason === 'string' || beta.stop_reason === null ? beta.stop_reason : null

  return { text, toolUses, stopReason }
}

function stringifyContent(content: HistoryMessage['content']): string {
  if (content == null) return ''
  return content
}

function serialiseArgs(args: unknown): string {
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args ?? {})
  } catch {
    return '{}'
  }
}

function toolResultIdentifier(msg: HistoryMessage): string {
  if (msg.toolCallId) return `tool_call_id="${msg.toolCallId}"`
  if (msg.toolName) return `tool_name="${msg.toolName}"`
  return 'tool_call_id="unknown"'
}

function findLastIndex<T>(arr: T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i]!)) return i
  return -1
}
