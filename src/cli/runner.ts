/**
 * One-shot CLI runner — feed a single prompt, stream assistant output to
 * stdout, surface tool_use lines to stderr so pipes stay clean.
 */

import {
  unstable_v2_createSession,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk'

import { RECOMMENDED_SUBPROCESS_ENV } from '../context-manager.ts'

export interface OneShotOptions {
  prompt: string
  model?: string
  system?: string
  cwd?: string
  maxTurns?: number
  /** Where to write tool-use trace lines. Default: process.stderr */
  trace?: NodeJS.WriteStream | { write: (s: string) => void }
  /** Where to write assistant text. Default: process.stdout */
  out?: NodeJS.WriteStream | { write: (s: string) => void }
}

export async function runOneShot(opts: OneShotOptions): Promise<{
  result: SDKResultMessage | null
  text: string
}> {
  const trace = opts.trace ?? process.stderr
  const out = opts.out ?? process.stdout

  const session: SDKSession = unstable_v2_createSession({
    model: opts.model ?? 'claude-sonnet-4-6',
    cwd: opts.cwd ?? process.cwd(),
    systemPrompt: opts.system,
    settingSources: ['project', 'local'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: opts.maxTurns ?? 10,
    includePartialMessages: true,
    env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
  })

  let collected = ''
  let result: SDKResultMessage | null = null

  try {
    await session.send(opts.prompt)
    for await (const msg of session.stream()) {
      if (msg.type === 'stream_event') {
        const ev = msg.event
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          out.write(ev.delta.text)
          collected += ev.delta.text
        }
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
          trace.write(`\n[tool] ${ev.content_block.name} (${ev.content_block.id})\n`)
        }
        continue
      }
      if (msg.type === 'assistant') {
        const am = msg as SDKAssistantMessage
        if (am.error) trace.write(`\n[error] ${am.error}\n`)
      }
      if (msg.type === 'result') {
        result = msg as SDKResultMessage
        out.write('\n')
        break
      }
    }
  } finally {
    await session.close().catch(() => {})
  }

  return { result, text: collected }
}
