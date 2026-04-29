/**
 * One-shot runner — backs `claude-sdk -p`. Honours --output-format with the
 * same semantics as official:
 *   text         (default) plain assistant text to stdout
 *   json         single result message as one line of JSON
 *   stream-json  every SDKMessage as one line of JSON
 */

import {
  unstable_v2_createSession,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

import type { ParsedArgs } from './args.ts'
import { buildSessionOptions } from './session-options.ts'
import { safeCloseSession } from './safe-close.ts'

export interface OneShotOptions {
  prompt: string
  args: ParsedArgs
  out?: { write: (s: string) => void }
  err?: { write: (s: string) => void }
}

export async function runOneShot(opts: OneShotOptions): Promise<{
  result: SDKResultMessage | null
  text: string
}> {
  const out = opts.out ?? process.stdout
  const err = opts.err ?? process.stderr
  const format = opts.args.outputFormat ?? 'text'

  const session = unstable_v2_createSession(
    buildSessionOptions({ args: opts.args, includePartialMessages: format !== 'json' }),
  )

  let collected = ''
  let result: SDKResultMessage | null = null
  let streamedText = false

  try {
    await session.send(opts.prompt)
    for await (const msg of session.stream()) {
      if (format === 'stream-json') {
        out.write(JSON.stringify(msg) + '\n')
      }

      if (format === 'text') {
        const wrote = emitText(msg, out, err, (chunk) => { collected += chunk }, streamedText)
        if (wrote) streamedText = true
      }

      if (msg.type === 'result') {
        result = msg as SDKResultMessage
        if (format === 'json') out.write(JSON.stringify(msg) + '\n')
        if (format === 'text') out.write('\n')
        break
      }
    }
  } finally {
    await safeCloseSession(session)
  }

  return { result, text: collected }
}

function emitText(
  msg: SDKMessage,
  out: { write: (s: string) => void },
  err: { write: (s: string) => void },
  onChunk: (s: string) => void,
  alreadyStreamed: boolean,
): boolean {
  if (msg.type === 'stream_event') {
    const ev = msg.event
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
      out.write(ev.delta.text)
      onChunk(ev.delta.text)
      return true
    }
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
      err.write(`\n[tool] ${ev.content_block.name}\n`)
    }
    return false
  }
  if (msg.type === 'assistant') {
    const am = msg as SDKAssistantMessage
    if (am.error) err.write(`\n[error] ${am.error}\n`)
    if (alreadyStreamed) return false
    // Fallback: dump text blocks if no stream_event ever arrived.
    const blocks = (am.message?.content ?? []) as Array<Record<string, unknown>>
    let wrote = false
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        out.write(b.text as string)
        onChunk(b.text as string)
        wrote = true
      }
      if (b?.type === 'tool_use' && typeof b.name === 'string') {
        err.write(`\n[tool] ${b.name as string}\n`)
      }
    }
    return wrote
  }
  return false
}
