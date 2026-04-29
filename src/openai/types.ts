/**
 * OpenAI Chat Completions API types — minimal subset.
 *
 * Spec: https://platform.openai.com/docs/api-reference/chat
 * Only the fields we actually consume / produce are typed.
 */

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type OpenAIMessageRole = 'system' | 'user' | 'assistant' | 'tool'

export interface OpenAIMessage {
  role: OpenAIMessageRole
  content: string | OpenAIContentPart[] | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
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
    function?: {
      name?: string
      arguments?: string
    }
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
