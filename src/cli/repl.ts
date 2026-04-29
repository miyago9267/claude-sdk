/**
 * Interactive REPL backed by a single long-lived V2 session, with
 * ContextManager watching the watermark and auto-compacting in place.
 */

import { createInterface } from 'node:readline/promises'

import {
  unstable_v2_createSession,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSession,
} from '@anthropic-ai/claude-agent-sdk'

import { ContextManager, RECOMMENDED_SUBPROCESS_ENV } from '../context-manager.ts'

export interface ReplOptions {
  model?: string
  system?: string
  cwd?: string
  maxTurns?: number
  watermarkTokens?: number
}

export async function runRepl(opts: ReplOptions = {}): Promise<void> {
  const model = opts.model ?? 'claude-sonnet-4-6'
  const cwd = opts.cwd ?? process.cwd()
  const system = opts.system

  const log = (line: string) => process.stderr.write(`[ctx] ${line}\n`)

  let session: SDKSession = createSession()
  let sessionId: string | null = null

  const manager = new ContextManager(
    {
      watermarkTokens: opts.watermarkTokens ?? 150_000,
      strategy: 'compact',
    },
    {
      enabled: false,
    },
    {
      getSession: () => session,
      getSessionId: () => sessionId,
      restartSession: async () => {
        await session.close().catch(() => {})
        session = createSession()
        sessionId = null
      },
      log,
      model,
      cwd,
    },
  )

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  process.stdout.write(`claude-sdk REPL (model=${model}, cwd=${cwd})\n`)
  process.stdout.write(`Type your prompt. Ctrl+D or "exit" to quit.\n\n`)

  while (true) {
    const line = await rl.question('> ').catch(() => null)
    if (line === null) break
    const input = line.trim()
    if (!input) continue
    if (input === 'exit' || input === 'quit') break

    try {
      await session.send(input)
      for await (const msg of session.stream()) {
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            process.stdout.write(ev.delta.text)
          }
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            process.stderr.write(`\n[tool] ${ev.content_block.name}\n`)
          }
          continue
        }
        if (msg.type === 'assistant') {
          const am = msg as SDKAssistantMessage
          if (am.error) process.stderr.write(`\n[error] ${am.error}\n`)
        }
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage
          sessionId = r.session_id
          manager.updateFromResult(r)
          process.stdout.write('\n')
          await manager.checkWatermark()
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`\n[error] ${message}\n`)
    }
  }

  rl.close()
  await session.close().catch(() => {})

  function createSession(): SDKSession {
    return unstable_v2_createSession({
      model,
      cwd,
      systemPrompt: system,
      settingSources: ['project', 'local'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: opts.maxTurns ?? 10,
      includePartialMessages: true,
      env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
    })
  }
}
