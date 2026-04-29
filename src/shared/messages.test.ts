import { describe, expect, test } from 'bun:test'

import {
  buildPromptFromHistory,
  detectImageMediaType,
  extractAssistantBlocks,
  stripDataUrlPrefix,
  type HistoryMessage,
} from './messages.ts'

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQ'

describe('buildPromptFromHistory', () => {
  test('extracts system prompt and single-user prompt verbatim', () => {
    const result = buildPromptFromHistory([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(result.systemPrompt).toBe('You are helpful.')
    expect(result.prompt).toBe('Hello')
  })

  test('renders multi-turn history as transcript', () => {
    const result = buildPromptFromHistory([
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

  test('renders tool_call with id when present', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'run' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'bash', arguments: { cmd: 'ls' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'file.txt' },
      { role: 'user', content: 'next' },
    ]
    const result = buildPromptFromHistory(messages)
    expect(result.prompt).toContain('[tool_call name="bash" id="call_1"]{"cmd":"ls"}[/tool_call]')
    expect(result.prompt).toContain('<tool_result tool_call_id="call_1">\nfile.txt\n</tool_result>')
  })

  test('renders tool_call without id (Ollama style) and tool_result keyed by name', () => {
    const messages: HistoryMessage[] = [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ name: 'get_weather', arguments: { city: 'Taipei' } }],
      },
      { role: 'tool', toolName: 'get_weather', content: 'sunny' },
      { role: 'user', content: 'thanks' },
    ]
    const result = buildPromptFromHistory(messages)
    expect(result.prompt).toContain('[tool_call name="get_weather"]{"city":"Taipei"}[/tool_call]')
    expect(result.prompt).toContain('<tool_result tool_name="get_weather">\nsunny\n</tool_result>')
  })

  test('serialises pre-stringified arguments as-is', () => {
    const result = buildPromptFromHistory([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }],
      },
    ])
    expect(result.prompt).toContain('[tool_call name="bash" id="c1"]{"cmd":"ls"}[/tool_call]')
  })

  test('returns null systemPrompt when no system message', () => {
    const result = buildPromptFromHistory([{ role: 'user', content: 'hi' }])
    expect(result.systemPrompt).toBeNull()
  })

  test('handles null content gracefully', () => {
    const result = buildPromptFromHistory([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, toolCalls: [{ name: 'noop', arguments: {} }] },
    ])
    expect(result.prompt).toContain('<user>\nhi\n</user>')
    expect(result.prompt).toContain('[tool_call name="noop"]{}[/tool_call]')
  })

  test('joins multiple system messages', () => {
    const result = buildPromptFromHistory([
      { role: 'system', content: 'one' },
      { role: 'system', content: 'two' },
      { role: 'user', content: 'go' },
    ])
    expect(result.systemPrompt).toBe('one\n\ntwo')
  })

  test('attachments is empty when no images provided', () => {
    const result = buildPromptFromHistory([{ role: 'user', content: 'hi' }])
    expect(result.attachments).toEqual([])
  })

  test('final-turn images surface as attachments with detected media type', () => {
    const result = buildPromptFromHistory([
      { role: 'user', content: 'what is in this?', images: [PNG_BASE64] },
    ])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mediaType).toBe('image/png')
    expect(result.attachments[0]?.base64).toBe(PNG_BASE64)
    expect(result.prompt).toBe('what is in this?')
  })

  test('earlier-turn images become placeholders, only final-turn images attached', () => {
    const result = buildPromptFromHistory([
      { role: 'user', content: 'first pic', images: [PNG_BASE64, PNG_BASE64] },
      { role: 'assistant', content: 'I see two pictures.' },
      { role: 'user', content: 'now this one', images: [JPEG_BASE64] },
    ])
    expect(result.prompt).toContain('[image attachment 1 omitted from transcript]')
    expect(result.prompt).toContain('[image attachment 2 omitted from transcript]')
    expect(result.prompt).toContain('<assistant>\nI see two pictures.\n</assistant>')
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]?.mediaType).toBe('image/jpeg')
  })

  test('user message with only an image (no text) still carries the attachment', () => {
    const result = buildPromptFromHistory([
      { role: 'user', content: '', images: [PNG_BASE64] },
    ])
    expect(result.attachments).toHaveLength(1)
  })

  test('strips data URL prefix when present in base64', () => {
    const dataUrl = `data:image/png;base64,${PNG_BASE64}`
    expect(stripDataUrlPrefix(dataUrl)).toBe(PNG_BASE64)
    expect(stripDataUrlPrefix(PNG_BASE64)).toBe(PNG_BASE64)
  })
})

describe('detectImageMediaType', () => {
  test.each([
    [PNG_BASE64, 'image/png'],
    [JPEG_BASE64, 'image/jpeg'],
    ['R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'image/gif'],
    ['UklGRiYAAABXRUJQVlA4', 'image/webp'],
    ['unknown-data', 'image/png'],
  ])('detects %s -> %s', (input, expected) => {
    expect(detectImageMediaType(input)).toBe(expected)
  })

  test('handles data URL prefix transparently', () => {
    expect(detectImageMediaType(`data:image/jpeg;base64,${JPEG_BASE64}`)).toBe('image/jpeg')
  })
})

describe('extractAssistantBlocks', () => {
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
    } as unknown as Parameters<typeof extractAssistantBlocks>[0]

    const out = extractAssistantBlocks(msg)
    expect(out.text).toBe('hello world')
    expect(out.toolUses).toEqual([{ id: 'tu_1', name: 'bash', input: { cmd: 'ls' } }])
    expect(out.stopReason).toBe('tool_use')
  })

  test('returns empty toolUses when only text', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'text', text: 'just text' }],
        stop_reason: 'end_turn',
      },
    } as unknown as Parameters<typeof extractAssistantBlocks>[0]
    const out = extractAssistantBlocks(msg)
    expect(out.text).toBe('just text')
    expect(out.toolUses).toEqual([])
    expect(out.stopReason).toBe('end_turn')
  })

  test('handles empty input on tool_use', () => {
    const msg = {
      type: 'assistant' as const,
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'noop' }],
        stop_reason: 'tool_use',
      },
    } as unknown as Parameters<typeof extractAssistantBlocks>[0]
    const out = extractAssistantBlocks(msg)
    expect(out.toolUses[0]?.input).toEqual({})
  })
})
