/**
 * Persistent session adapter over the public `query()` streaming-input API.
 *
 * Replaces the removed `unstable_v2_createSession` (gone in agent-sdk 0.3.x).
 * It keeps the exact surface the rest of the codebase relied on — `send()` /
 * `stream()` / `close()` — so call sites only swap the constructor name.
 *
 * Mechanism: `query()` consumes an AsyncIterable of user messages and yields a
 * single continuous SDKMessage generator across all turns. We back the input
 * with a queue we can push to (send), and expose `stream()` as a per-turn view
 * that yields until the turn's `result` message, then pauses without ending
 * the underlying generator — so the next `send()` resumes the same session
 * (same child process, byte-identical cache prefix).
 */

import {
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

/** What `send()` accepts: a plain prompt string, or a pre-built user message. */
export type V2SendInput =
  | string
  | {
      type: 'user'
      message: { role: 'user'; content: unknown }
      parent_tool_use_id: string | null
    }

export interface V2Session {
  send(input: V2SendInput): Promise<void>
  stream(): AsyncGenerator<SDKMessage>
  close(): void
}

function toUserMessage(input: V2SendInput): SDKUserMessage {
  if (typeof input === 'string') {
    return {
      type: 'user',
      message: { role: 'user', content: input },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage
  }
  return input as unknown as SDKUserMessage
}

export function createV2Session(options: Options): V2Session {
  const queue: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  let closed = false

  async function* input(): AsyncGenerator<SDKUserMessage> {
    while (!closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      while (queue.length) yield queue.shift()!
    }
  }

  const q: Query = query({ prompt: input(), options })
  const iter = q[Symbol.asyncIterator]()

  return {
    async send(inp: V2SendInput): Promise<void> {
      queue.push(toUserMessage(inp))
      const w = wake
      wake = null
      w?.()
    },

    async *stream(): AsyncGenerator<SDKMessage> {
      while (true) {
        const { value, done } = await iter.next()
        if (done) return
        yield value
        if (value.type === 'result') return
      }
    },

    close(): void {
      closed = true
      const w = wake
      wake = null
      w?.()
      void Promise.resolve(q.interrupt?.()).catch(() => {})
    },
  }
}
