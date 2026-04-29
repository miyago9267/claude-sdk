import { describe, expect, test } from 'bun:test'

import type { AssistantBlocks } from '../shared/messages.ts'
import {
  OLLAMA_CAPABILITIES,
  buildDoneFrame,
  buildPromptFromOllamaMessages,
  buildShowResponse,
  buildTagsResponse,
  buildTextDeltaFrame,
  buildThinkingDeltaFrame,
  buildToolCallFrame,
  mapDoneReason,
  ollamaMessagesToHistory,
} from './transform.ts'

describe('ollamaMessagesToHistory', () => {
  test('passes role and content through', () => {
    const out = ollamaMessagesToHistory([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ])
    expect(out).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ])
  })

  test('lifts tool_calls into HistoryToolCall[]', () => {
    const out = ollamaMessagesToHistory([
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'bash', arguments: { cmd: 'ls' } } }],
      },
    ])
    expect(out[0]?.toolCalls).toEqual([{ name: 'bash', arguments: { cmd: 'ls' } }])
  })

  test('lifts tool_name on tool result', () => {
    const out = ollamaMessagesToHistory([
      { role: 'tool', tool_name: 'get_weather', content: '20C' },
    ])
    expect(out[0]?.toolName).toBe('get_weather')
  })

  test('lifts images onto HistoryMessage', () => {
    const out = ollamaMessagesToHistory([
      { role: 'user', content: 'see this', images: ['iVBORw0KGgo'] },
    ])
    expect(out[0]?.images).toEqual(['iVBORw0KGgo'])
  })
})

describe('buildPromptFromOllamaMessages', () => {
  test('end-to-end single user prompt', () => {
    const r = buildPromptFromOllamaMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(r.systemPrompt).toBe('sys')
    expect(r.prompt).toBe('hi')
  })

  test('multi-turn with Ollama-style tool result keyed by name', () => {
    const r = buildPromptFromOllamaMessages([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Taipei' } } }],
      },
      { role: 'tool', tool_name: 'get_weather', content: 'sunny' },
      { role: 'user', content: 'thanks' },
    ])
    expect(r.prompt).toContain('[tool_call name="get_weather"]{"city":"Taipei"}[/tool_call]')
    expect(r.prompt).toContain('<tool_result tool_name="get_weather">\nsunny\n</tool_result>')
  })
})

describe('mapDoneReason', () => {
  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'stop'],
    ['refusal', 'stop'],
    ['max_tokens', 'length'],
    [null, 'stop'],
    [undefined, 'stop'],
  ])('%s -> %s', (input, expected) => {
    expect(mapDoneReason(input as never)).toBe(expected as string)
  })
})

describe('buildDoneFrame', () => {
  const blocks: AssistantBlocks = {
    text: 'hello',
    toolUses: [{ name: 'bash', input: { cmd: 'ls' } }],
    stopReason: 'tool_use',
  }

  test('packs text + tool_calls and uses tool_use → stop done_reason', () => {
    const frame = buildDoneFrame({
      model: 'claude-sonnet-4-6',
      blocks,
      result: null,
    })
    expect(frame.done).toBe(true)
    expect(frame.done_reason).toBe('stop')
    expect(frame.message.role).toBe('assistant')
    expect(frame.message.content).toBe('hello')
    expect(frame.message.tool_calls).toEqual([
      { function: { name: 'bash', arguments: { cmd: 'ls' } } },
    ])
  })

  test('forwards thinking when provided', () => {
    const frame = buildDoneFrame({
      model: 'claude-opus-4-7',
      blocks: { text: 'ok', toolUses: [], stopReason: 'end_turn' },
      thinking: 'pondering...',
      result: null,
    })
    expect(frame.message.thinking).toBe('pondering...')
  })

  test('extracts usage from SDKResultMessage', () => {
    const result = {
      type: 'result',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 0,
      },
    } as never
    const frame = buildDoneFrame({
      model: 'm',
      blocks: { text: '', toolUses: [], stopReason: null },
      result,
    })
    expect(frame.prompt_eval_count).toBe(300)
    expect(frame.eval_count).toBe(50)
  })
})

describe('streaming partial frames', () => {
  test('text delta', () => {
    const f = buildTextDeltaFrame('m', 'foo')
    expect(f.done).toBe(false)
    expect(f.message.content).toBe('foo')
  })

  test('tool call frame carries object args', () => {
    const f = buildToolCallFrame('m', { name: 'read', input: { path: '/a' } })
    expect(f.message.tool_calls).toEqual([
      { function: { name: 'read', arguments: { path: '/a' } } },
    ])
  })

  test('thinking delta frame', () => {
    const f = buildThinkingDeltaFrame('m', 'reasoning...')
    expect(f.message.thinking).toBe('reasoning...')
    expect(f.message.content).toBe('')
  })
})

describe('buildTagsResponse', () => {
  test('emits one entry per model id with claude family', () => {
    const r = buildTagsResponse(['claude-sonnet-4-6', 'claude-opus-4-7'])
    expect(r.models).toHaveLength(2)
    expect(r.models[0]?.name).toBe('claude-sonnet-4-6')
    expect(r.models[0]?.details.family).toBe('claude')
    expect(r.models[0]?.details.parameter_size).toBe('200B')
    expect(r.models[1]?.details.parameter_size).toBe('500B+')
  })
})

describe('buildShowResponse', () => {
  test('advertises tools so model is visible in Copilot Agent picker', () => {
    const r = buildShowResponse('claude-sonnet-4-6')
    expect(r.capabilities).toEqual([...OLLAMA_CAPABILITIES])
    expect(r.capabilities).toContain('tools')
    expect(r.capabilities).toContain('vision')
    expect(r.capabilities).toContain('thinking')
  })

  test('parameter_size adapts to model tier', () => {
    expect(buildShowResponse('claude-haiku-4-5').details.parameter_size).toBe('70B')
    expect(buildShowResponse('claude-sonnet-4-6').details.parameter_size).toBe('200B')
    expect(buildShowResponse('claude-opus-4-7').details.parameter_size).toBe('500B+')
  })

  test('model_info carries architecture + context length under the right key', () => {
    const r = buildShowResponse('claude-opus-4-7')
    expect(r.model_info?.['general.architecture']).toBe('claude')
    expect(r.model_info?.['claude.context_length']).toBe(1_000_000)
    expect(r.model_info?.['general.basename']).toBe('Claude Opus 4.7 (1M)')
  })

  test('non-opus-4.7 Claude models default to 200K context', () => {
    expect(buildShowResponse('claude-sonnet-4-6').model_info?.['claude.context_length']).toBe(200_000)
    expect(buildShowResponse('claude-haiku-4-5').model_info?.['claude.context_length']).toBe(200_000)
  })
})
