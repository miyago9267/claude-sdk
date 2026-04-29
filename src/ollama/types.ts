/**
 * Ollama HTTP API wire format — minimal subset that GitHub Copilot Chat hits.
 *
 * Reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Only the fields we consume or emit are typed. Optional fields the official
 * API may include but we never look at are omitted intentionally.
 */

export type OllamaRole = 'system' | 'user' | 'assistant' | 'tool'

export interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface OllamaMessage {
  role: OllamaRole
  content?: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface OllamaToolDefinition {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

export interface OllamaChatRequest {
  model: string
  messages: OllamaMessage[]
  tools?: OllamaToolDefinition[]
  think?: boolean
  format?: string | Record<string, unknown>
  options?: Record<string, unknown>
  stream?: boolean
  keep_alive?: string | number
}

export interface OllamaChatFrame {
  model: string
  created_at: string
  message: OllamaMessage
  done: boolean
  done_reason?: string
  total_duration?: number
  load_duration?: number
  prompt_eval_count?: number
  prompt_eval_duration?: number
  eval_count?: number
  eval_duration?: number
}

export interface OllamaModelDetails {
  parent_model: string
  format: string
  family: string
  families: string[]
  parameter_size: string
  quantization_level: string
}

export interface OllamaModelTag {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details: OllamaModelDetails
}

export interface OllamaTagsResponse {
  models: OllamaModelTag[]
}

export interface OllamaShowRequest {
  model: string
  verbose?: boolean
}

export interface OllamaShowResponse {
  modelfile: string
  parameters: string
  template: string
  details: OllamaModelDetails
  model_info?: Record<string, unknown>
  capabilities: string[]
}

export interface OllamaVersionResponse {
  version: string
}

export interface OllamaErrorResponse {
  error: string
}
