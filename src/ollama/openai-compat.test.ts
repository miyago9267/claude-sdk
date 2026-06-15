import { describe, expect, test } from 'bun:test'

import {
  StreamingChunkConverter,
  attachmentsFromHistory,
  buildPromptFromOpenAIMessages,
  extractAssistantContent,
  mapStopReason,
  openAIMessagesToHistory,
  resultErrorMessage,
} from './openai-compat.ts'

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
const PNG_RAW = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='

describe('openAIMessagesToHistory', () => {
  test('plain text passthrough', () => {
    const out = openAIMessagesToHistory([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('parses tool_calls arguments string into object', () => {
    const out = openAIMessagesToHistory([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
    ])
    expect(out[0]?.toolCalls).toEqual([
      { id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } },
    ])
  })

  test('keeps non-JSON tool_calls arguments as raw string', () => {
    const out = openAIMessagesToHistory([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'echo', arguments: 'not-json' } },
        ],
      },
    ])
    expect(out[0]?.toolCalls?.[0]?.arguments).toBe('not-json')
  })

  test('lifts tool_call_id on tool result', () => {
    const out = openAIMessagesToHistory([
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
    ])
    expect(out[0]?.toolCallId).toBe('call_1')
  })

  test('extracts data: URL images from content parts into images[]', () => {
    const out = openAIMessagesToHistory([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
      },
    ])
    expect(out[0]?.content).toBe('see this')
    expect(out[0]?.images).toEqual([PNG_DATA_URL])
  })

  test('drops non-data image_url (we cannot fetch remote URLs synchronously)', () => {
    const out = openAIMessagesToHistory([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
      },
    ])
    expect(out[0]?.images ?? []).toEqual([])
  })
})

describe('buildPromptFromOpenAIMessages', () => {
  test('end-to-end: system + single user → verbatim prompt', () => {
    const r = buildPromptFromOpenAIMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
    expect(r.systemPrompt).toBe('sys')
    expect(r.prompt).toBe('hi')
  })

  test('multi-turn renders transcript with tool_call + tool_result', () => {
    const r = buildPromptFromOpenAIMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
      { role: 'user', content: 'next' },
    ])
    expect(r.prompt).toContain('[tool_call name="bash" id="c1"]{"cmd":"ls"}[/tool_call]')
    expect(r.prompt).toContain('<tool_result tool_call_id="c1">\nfile.txt\n</tool_result>')
  })

  test('attachments are extracted from final user image_url', () => {
    const r = buildPromptFromOpenAIMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
      },
    ])
    const atts = attachmentsFromHistory(openAIMessagesToHistory([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this?' },
          { type: 'image_url', image_url: { url: PNG_DATA_URL } },
        ],
      },
    ]))
    expect(r.prompt).toBe('what is in this?')
    expect(atts).toHaveLength(1)
    expect(atts[0]?.mediaType).toBe('image/png')
    expect(atts[0]?.base64).toBe(PNG_DATA_URL)
  })
})

describe('mapStopReason', () => {
  test.each([
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
  ])('%s -> %s', (claude, openai) => {
    expect(mapStopReason(claude)).toBe(openai as ReturnType<typeof mapStopReason>)
  })

  test('null/undefined -> null', () => {
    expect(mapStopReason(null)).toBeNull()
    expect(mapStopReason(undefined)).toBeNull()
  })
})

describe('extractAssistantContent', () => {
  test('text + tool_use blocks', () => {
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
    expect(out.toolCalls[0]).toMatchObject({
      id: 'tu_1',
      type: 'function',
      function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    expect(out.finishReason).toBe('tool_calls')
  })
})

describe('StreamingChunkConverter', () => {
  test('role chunk emitted once on message_start', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const a = conv.fromStreamEvent({ type: 'message_start', message: {} as never } as never)
    expect(a?.choices[0]?.delta.role).toBe('assistant')
    const b = conv.fromStreamEvent({ type: 'message_start', message: {} as never } as never)
    expect(b).toBeNull()
  })

  test('text_delta -> content delta chunk', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const c = conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'foo' },
    } as never)
    expect(c?.choices[0]?.delta.content).toBe('foo')
  })

  test('tool_use stream events are dropped (chat-only bridge)', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const start = conv.fromStreamEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu', name: 'bash', input: {} },
    } as never)
    const d1 = conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"cmd":' },
    } as never)
    expect(start).toBeNull()
    expect(d1).toBeNull()
  })

  test('message_delta with tool_use stop_reason flips to stop (tool_calls dropped)', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    conv.fromStreamEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: {} as never,
    } as never)
    expect(conv.buildFinishChunk().choices[0]?.finish_reason).toBe('stop')
  })

  test('buildFinishChunk falls back to stop when no message_delta', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    expect(conv.buildFinishChunk().choices[0]?.finish_reason).toBe('stop')
  })

  test('fromAssistantMessage emits text only; tool_use blocks dropped (chat-only)', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [
          { type: 'text', text: 'hello world' },
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } },
        ],
        stop_reason: 'tool_use',
      },
    } as unknown as Parameters<typeof conv.fromAssistantMessage>[0]
    const chunks = conv.fromAssistantMessage(msg)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.choices[0]?.delta.content).toBe('hello world')
    expect(chunks[0]?.choices[0]?.delta.tool_calls).toBeUndefined()
    // tool_calls finish_reason flips to 'stop' because we dropped the tool calls
    expect(conv.buildFinishChunk().choices[0]?.finish_reason).toBe('stop')
  })

  test('fromAssistantMessage emits nothing when assistant turn is pure tool_use', () => {
    // Mid-agent-loop "silent work" turns must not spam the client with
    // placeholder messages. Final-turn text comes through later.
    const conv = new StreamingChunkConverter('id', 'm')
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }],
        stop_reason: 'tool_use',
      },
    } as unknown as Parameters<typeof conv.fromAssistantMessage>[0]
    expect(conv.fromAssistantMessage(msg)).toEqual([])
  })

  test('multi-turn agent: every assistant message gets its content emitted', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const turn = (text: string) =>
      conv.fromAssistantMessage({
        type: 'assistant',
        message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' },
      } as unknown as Parameters<typeof conv.fromAssistantMessage>[0])
    expect(turn('first turn')[0]?.choices[0]?.delta.content).toBe('first turn')
    expect(turn('second turn')[0]?.choices[0]?.delta.content).toBe('second turn')
    expect(turn('third turn')[0]?.choices[0]?.delta.content).toBe('third turn')
  })

  test('hasEmittedFromStream flips on text_delta then resets on assistant boundary', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    expect(conv.hasEmittedFromStream()).toBe(false)
    conv.fromStreamEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'foo' },
    } as never)
    expect(conv.hasEmittedFromStream()).toBe(true)
    // assistant boundary: skip (already emitted via stream) and reset for next turn
    const skipped = conv.fromAssistantMessage({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'foo' }], stop_reason: 'end_turn' },
    } as unknown as Parameters<typeof conv.fromAssistantMessage>[0])
    expect(skipped).toEqual([])
    expect(conv.hasEmittedFromStream()).toBe(false)
  })

  test('fromAssistantMessage emits nothing for empty assistant message', () => {
    const conv = new StreamingChunkConverter('id', 'm')
    const msg = {
      type: 'assistant' as const,
      message: { content: [], stop_reason: 'end_turn' },
    } as unknown as Parameters<typeof conv.fromAssistantMessage>[0]
    expect(conv.fromAssistantMessage(msg)).toEqual([])
  })
})

describe('resultErrorMessage', () => {
  test('null result -> null', () => {
    expect(resultErrorMessage(null, '')).toBeNull()
  })

  test('success result -> null', () => {
    const ok = { type: 'result', subtype: 'success', is_error: false, result: 'hi' } as never
    expect(resultErrorMessage(ok, 'hi')).toBeNull()
  })

  test('is_error with no assistant text -> verbatim upstream message (e.g. model not granted)', () => {
    const err = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
    } as never
    expect(resultErrorMessage(err, '')).toBe(
      "There's an issue with the selected model (claude-fable-5). It may not exist or you may not have access to it.",
    )
  })

  test('is_error but assistant produced text -> null (prefer returning the text)', () => {
    const err = { type: 'result', subtype: 'error_max_turns', is_error: true } as never
    expect(resultErrorMessage(err, 'partial answer')).toBeNull()
  })

  test('is_error with no message field -> synthesised from subtype', () => {
    const err = { type: 'result', subtype: 'error_during_execution', is_error: true } as never
    expect(resultErrorMessage(err, '')).toBe('upstream error (error_during_execution)')
  })
})

describe('attachmentsFromHistory', () => {
  test('returns empty when no user images', () => {
    expect(attachmentsFromHistory([{ role: 'user', content: 'hi' }])).toEqual([])
  })

  test('reads from last user message only', () => {
    const result = attachmentsFromHistory([
      { role: 'user', content: 'first', images: [PNG_RAW] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second', images: [PNG_RAW, PNG_RAW] },
    ])
    expect(result).toHaveLength(2)
  })
})
