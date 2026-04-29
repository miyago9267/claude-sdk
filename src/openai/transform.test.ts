import { describe, expect, test } from 'bun:test'

import {
  StreamingChunkConverter,
  buildPromptFromOpenAIMessages,
  extractAssistantContent,
  mapStopReason,
} from './transform.ts'

describe('buildPromptFromOpenAIMessages', () => {
  test('extracts system prompt and single-user prompt verbatim', () => {
    const result = buildPromptFromOpenAIMessages([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(result.systemPrompt).toBe('You are helpful.')
    expect(result.prompt).toBe('Hello')
  })

  test('renders multi-turn history as transcript', () => {
    const result = buildPromptFromOpenAIMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'follow up' },
    ])
    expect(result.systemPrompt).toBe('sys')
    expect(result.prompt).toContain('<user>\nhi\n</user>')
    expect(result.prompt).toContain('<assistant>\nhello\n</assistant>')
    expect(result.prompt).toContain('<user>\nfollow up\n</user>')
  })

  test('renders tool calls and tool results', () => {
    const result = buildPromptFromOpenAIMessages([
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'bash', arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
      { role: 'user', content: 'next' },
    ])
    expect(result.prompt).toContain('[tool_call name="bash" id="call_1"]{"cmd":"ls"}[/tool_call]')
    expect(result.prompt).toContain('<tool_result tool_call_id="call_1">\nfile.txt\n</tool_result>')
  })

  test('returns null systemPrompt when no system message', () => {
    const result = buildPromptFromOpenAIMessages([{ role: 'user', content: 'hi' }])
    expect(result.systemPrompt).toBeNull()
  })

  test('handles array content parts (text only)', () => {
    const result = buildPromptFromOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      },
    ])
    expect(result.prompt).toBe('part1\npart2')
  })
})

describe('mapStopReason', () => {
  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
  ])('maps %s -> %s', (claude, openai) => {
    expect(mapStopReason(claude)).toBe(openai as ReturnType<typeof mapStopReason>)
  })

  test('maps null/undefined to null', () => {
    expect(mapStopReason(null)).toBeNull()
    expect(mapStopReason(undefined)).toBeNull()
  })
})

describe('extractAssistantContent', () => {
  test('pulls text and tool_use blocks', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    } as unknown as Parameters<typeof extractAssistantContent>[0]

    const out = extractAssistantContent(msg)
    expect(out.text).toBe('hello world')
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]).toMatchObject({
      id: 'tu_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    expect(out.finishReason).toBe('tool_calls')
  })
})

describe('StreamingChunkConverter', () => {
  test('emits role on message_start exactly once', () => {
    const conv = new StreamingChunkConverter('test-id', 'claude-sonnet-4-6')
    const start = conv.fromStreamEvent({
      type: 'message_start',
      message: {} as unknown as never,
    } as never)
    expect(start?.choices[0]?.delta.role).toBe('assistant')

    const start2 = conv.fromStreamEvent({
      type: 'message_start',
      message: {} as unknown as never,
    } as never)
    expect(start2).toBeNull()
  })

  test('text_delta -> content delta', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const chunk = conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'foo' },
    } as never)
    expect(chunk?.choices[0]?.delta.content).toBe('foo')
  })

  test('tool_use start + input_json_delta accumulate under same index', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const startA = conv.fromStreamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_a', name: 'bash', input: {} },
    } as never)
    const deltaA = conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
    } as never)
    const startB = conv.fromStreamEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'tu_b', name: 'read', input: {} },
    } as never)
    const deltaA2 = conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"ls"}' },
    } as never)

    expect(startA?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      id: 'tu_a',
      type: 'function',
      function: { name: 'bash', arguments: '' },
    })
    expect(deltaA?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      function: { arguments: '{"cmd":' },
    })
    expect(startB?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 1,
      id: 'tu_b',
    })
    expect(deltaA2?.choices[0]?.delta.tool_calls?.[0]).toMatchObject({
      index: 0,
      function: { arguments: '"ls"}' },
    })
  })

  test('message_delta captures stop_reason for finish chunk', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    conv.fromStreamEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: {} as never,
    } as never)
    const finish = conv.buildFinishChunk()
    expect(finish.choices[0]?.finish_reason).toBe('tool_calls')
  })

  test('buildFinishChunk falls back to stop when no message_delta seen', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const finish = conv.buildFinishChunk()
    expect(finish.choices[0]?.finish_reason).toBe('stop')
  })
})
