/**
 * TUI bridge — spawn the Go bubbletea binary, drive it via NDJSON.
 *
 * - Outbound (TS → Go): assistant text deltas, tool-use markers, results,
 *   errors, status snapshots. Sent on the binary's stdin.
 * - Inbound (Go → TS): user prompts, slash commands, exit. Read from the
 *   binary's stdout.
 *
 * The binary is built by `bash scripts/build-tui.sh`. Schema lives next to
 * the Go side in cmd/tui/ipc.go — keep both in sync.
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  unstable_v2_createSession,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKSession,
  type SDKSessionOptions,
} from '@anthropic-ai/claude-agent-sdk'

import { ContextManager } from '../context-manager.ts'
import type { ParsedArgs } from './args.ts'
import { buildSessionOptions } from './session-options.ts'

export interface TuiOptions {
  args: ParsedArgs
  binaryPath?: string
}

interface HostEvent {
  type:
    | 'banner'
    | 'text-delta'
    | 'tool-use'
    | 'assistant-end'
    | 'result'
    | 'error'
    | 'status'
    | 'busy'
  text?: string
  model?: string
  cwd?: string
  name?: string
  id?: string
  sessionId?: string
  contextTokens?: number
  costUSD?: number
  compactions?: number
  message?: string
  reason?: string
}

interface UIEvent {
  type: 'prompt' | 'slash' | 'exit'
  text?: string
  cmd?: string
}

export async function runTui(opts: TuiOptions): Promise<void> {
  const binary = opts.binaryPath ?? resolveBinary()
  if (!existsSync(binary)) {
    process.stderr.write(
      `claude-sdk: TUI binary not found at ${binary}.\n` +
        `Build it once: bash scripts/build-tui.sh (requires Go 1.24+).\n`,
    )
    process.exit(2)
  }

  let sessionOptions = buildSessionOptions({ args: opts.args })
  let session: SDKSession = unstable_v2_createSession(sessionOptions)
  let sessionId: string | null = null
  let busy = false

  // stdin/stdout/stderr stay on the real TTY so bubbletea sees raw key events.
  // FD 3 carries HostEvents from us into the binary; FD 4 carries UIEvents back.
  const child = spawn(binary, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'],
  })

  const hostOut = (child.stdio[3] ?? null) as Writable | null
  const uiIn = (child.stdio[4] ?? null) as Readable | null
  if (!hostOut || !uiIn) {
    process.stderr.write('claude-sdk: failed to open IPC fds 3/4 to TUI binary\n')
    child.kill()
    return
  }

  const sendToTui = (ev: HostEvent) => {
    if (hostOut.destroyed) return
    hostOut.write(JSON.stringify(ev) + '\n')
  }

  const log = (line: string) => sendToTui({ type: 'status', message: line })

  const manager = new ContextManager(
    {
      watermarkTokens: opts.args.watermark ?? 150_000,
      strategy: 'compact',
    },
    { enabled: false },
    {
      getSession: () => session,
      getSessionId: () => sessionId,
      restartSession: async () => {
        await session.close().catch(() => {})
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
      },
      log,
      model: sessionOptions.model,
      cwd: sessionOptions.cwd ?? process.cwd(),
    },
  )

  sendToTui({
    type: 'banner',
    model: sessionOptions.model,
    cwd: sessionOptions.cwd,
  })

  const childExit = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit())
  })

  ;(async () => {
    for await (const ev of readNdjson(uiIn)) {
      try {
        await handleUIEvent(ev)
      } catch (err) {
        sendToTui({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    }
  })()

  await childExit
  await session.close().catch(() => {})

  async function handleUIEvent(ev: UIEvent): Promise<void> {
    if (ev.type === 'exit') {
      child.kill()
      return
    }
    if (ev.type === 'slash') {
      await handleSlash(ev.cmd ?? '')
      return
    }
    if (ev.type === 'prompt') {
      await runTurn(ev.text ?? '')
    }
  }

  async function runTurn(prompt: string): Promise<void> {
    if (!prompt.trim() || busy) return
    busy = true
    sendToTui({ type: 'busy', reason: 'true' })
    try {
      await session.send(prompt)
      for await (const msg of session.stream()) {
        if (msg.type === 'stream_event') {
          const e = msg.event
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            sendToTui({ type: 'text-delta', text: e.delta.text })
          }
          if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
            sendToTui({ type: 'tool-use', name: e.content_block.name, id: e.content_block.id })
          }
          continue
        }
        if (msg.type === 'assistant') {
          const am = msg as SDKAssistantMessage
          if (am.error) sendToTui({ type: 'error', message: String(am.error) })
        }
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage
          sessionId = r.session_id
          manager.updateFromResult(r)
          sendToTui({ type: 'assistant-end' })
          sendToTui({
            type: 'result',
            sessionId: r.session_id,
            contextTokens: manager.getState().contextTokensEstimate,
            costUSD: 'total_cost_usd' in r ? r.total_cost_usd : 0,
            compactions: manager.getState().totalCompactions,
          })
          await manager.checkWatermark()
          break
        }
      }
    } catch (err) {
      sendToTui({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      busy = false
      sendToTui({ type: 'busy', reason: 'false' })
    }
  }

  async function handleSlash(cmd: string): Promise<void> {
    const [head, ...rest] = cmd.split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (head) {
      case '/help':
        sendToTui({
          type: 'status',
          message: '/help /clear /model <id> /cwd [path] /compact /status /exit',
        })
        return
      case '/clear':
        await session.close().catch(() => {})
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        sendToTui({ type: 'status', message: 'session reset', model: sessionOptions.model })
        return
      case '/model':
        if (!arg) {
          sendToTui({ type: 'status', message: `current model: ${sessionOptions.model}` })
          return
        }
        sessionOptions = { ...sessionOptions, model: arg }
        await session.close().catch(() => {})
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        sendToTui({ type: 'banner', model: arg, cwd: sessionOptions.cwd })
        return
      case '/cwd':
        if (arg) {
          sessionOptions = { ...sessionOptions, cwd: arg } as SDKSessionOptions
          await session.close().catch(() => {})
          session = unstable_v2_createSession(sessionOptions)
          sessionId = null
          sendToTui({ type: 'banner', model: sessionOptions.model, cwd: arg })
        } else {
          sendToTui({ type: 'status', message: sessionOptions.cwd ?? process.cwd() })
        }
        return
      case '/compact':
        await manager.checkWatermark()
        sendToTui({
          type: 'result',
          sessionId: sessionId ?? '',
          contextTokens: manager.getState().contextTokensEstimate,
          compactions: manager.getState().totalCompactions,
        })
        return
      case '/status': {
        const state = manager.getState()
        sendToTui({
          type: 'status',
          model: sessionOptions.model,
          cwd: sessionOptions.cwd,
          contextTokens: state.contextTokensEstimate,
          compactions: state.totalCompactions,
        })
        return
      }
      default:
        sendToTui({ type: 'error', message: `unknown command: ${head}` })
    }
  }
}

async function* readNdjson(stream: Readable): AsyncGenerator<UIEvent> {
  let buf = ''
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        yield JSON.parse(line) as UIEvent
      } catch {
        continue
      }
    }
  }
}

function resolveBinary(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../../bin/claude-sdk-tui')
}
