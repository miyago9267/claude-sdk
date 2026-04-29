/**
 * Interactive REPL backed by a single long-lived V2 session.
 *
 * Slash commands roughly mirror the subset users actually reach for:
 *   /help, /exit, /quit, /clear, /model <id>, /compact, /status, /cwd
 * The official CLI exposes far more (skills, plugins, agents...) but this
 * stays at the minimum-viable mimic — args + REPL ergonomics, no TUI.
 */

import { createInterface, type Interface } from 'node:readline/promises'

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
import { c } from './colors.ts'
import {
  discoverCommands,
  discoverSkills,
  formatList,
} from './discover.ts'

export interface ReplOptions {
  args: ParsedArgs
  seedPrompt?: string
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const args = opts.args
  let sessionOptions = buildSessionOptions({ args })
  let session: SDKSession = unstable_v2_createSession(sessionOptions)
  let sessionId: string | null = null
  let lastResult: SDKResultMessage | null = null

  const log = (line: string) => process.stderr.write(`${c.gray(`[ctx] ${line}`)}\n`)

  const manager = new ContextManager(
    {
      watermarkTokens: args.watermark ?? 150_000,
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

  printBanner(sessionOptions)

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const cmdList = discoverCommands({ cwd: sessionOptions.cwd ?? process.cwd() })
  const skillList = discoverSkills({ cwd: sessionOptions.cwd ?? process.cwd() })
  if (cmdList.length || skillList.length) {
    process.stderr.write(
      c.gray(
        `[discover] ${cmdList.length} commands · ${skillList.length} skills (try /commands /skills)\n`,
      ),
    )
  }

  if (opts.seedPrompt) {
    await runTurn(opts.seedPrompt)
  }

  while (true) {
    const line = await rl.question(c.cyan('> ')).catch(() => null)
    if (line === null) break
    const input = line.trim()
    if (!input) continue

    if (input.startsWith('/')) {
      const stop = await handleSlash(input, rl)
      if (stop) break
      continue
    }

    await runTurn(input)
  }

  rl.close()
  await session.close().catch(() => {})

  async function runTurn(prompt: string): Promise<void> {
    try {
      await session.send(prompt)
      for await (const msg of session.stream()) {
        if (msg.type === 'stream_event') {
          const ev = msg.event
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
            process.stdout.write(ev.delta.text)
          }
          if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') {
            process.stderr.write(`\n${c.dim(`[tool] ${ev.content_block.name}`)}\n`)
          }
          continue
        }
        if (msg.type === 'assistant') {
          const am = msg as SDKAssistantMessage
          if (am.error) process.stderr.write(`\n${c.red(`[error] ${am.error}`)}\n`)
        }
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage
          lastResult = r
          sessionId = r.session_id
          manager.updateFromResult(r)
          process.stdout.write('\n')
          await manager.checkWatermark()
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`\n${c.red(`[error] ${message}`)}\n`)
    }
  }

  async function handleSlash(input: string, _rl: Interface): Promise<boolean> {
    const [cmd, ...rest] = input.split(/\s+/)
    const arg = rest.join(' ').trim()

    switch (cmd) {
      case '/exit':
      case '/quit':
        return true

      case '/help':
        process.stdout.write(SLASH_HELP)
        return false

      case '/clear':
        await session.close().catch(() => {})
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        manager.updateFromResult(undefined)
        process.stdout.write(c.green('session reset\n'))
        return false

      case '/model':
        if (!arg) {
          process.stdout.write(`current model: ${sessionOptions.model}\n`)
          return false
        }
        sessionOptions = { ...sessionOptions, model: arg }
        await session.close().catch(() => {})
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        process.stdout.write(c.green(`model -> ${arg} (session reset)\n`))
        return false

      case '/compact':
        await manager.checkWatermark()
        process.stdout.write(c.green('compact requested\n'))
        return false

      case '/status': {
        const state = manager.getState()
        const sid = sessionId ?? '(no result yet)'
        const cost = lastResult && 'total_cost_usd' in lastResult ? lastResult.total_cost_usd : 0
        process.stdout.write(
          [
            `model:           ${sessionOptions.model}`,
            `cwd:             ${sessionOptions.cwd}`,
            `session_id:      ${sid}`,
            `context tokens:  ~${state.contextTokensEstimate}`,
            `compactions:     ${state.totalCompactions}`,
            `last cost (USD): ${cost.toFixed(4)}`,
            '',
          ].join('\n'),
        )
        return false
      }

      case '/cwd':
        if (arg) {
          sessionOptions = { ...sessionOptions, cwd: arg }
          await session.close().catch(() => {})
          session = unstable_v2_createSession(sessionOptions)
          sessionId = null
          process.stdout.write(c.green(`cwd -> ${arg} (session reset)\n`))
        } else {
          process.stdout.write(`${sessionOptions.cwd}\n`)
        }
        return false

      case '/commands': {
        const list = discoverCommands({ cwd: sessionOptions.cwd ?? process.cwd() })
        process.stdout.write(formatList('Slash commands', list) + '\n')
        return false
      }

      case '/skills': {
        const list = discoverSkills({ cwd: sessionOptions.cwd ?? process.cwd() })
        process.stdout.write(formatList('Skills', list) + '\n')
        return false
      }

      default:
        // Forward unknown /commands to the SDK so cli.js's slash dispatcher
        // can handle /init, /agents, /review, /skill-name etc.
        await runTurn(input)
        return false
    }
  }
}

const SLASH_HELP = `\
Slash commands handled here (TS side):
  /help            this list
  /exit, /quit     leave the REPL
  /clear           drop the current session and start a new one
  /model [id]      show or switch model (resets session)
  /cwd   [path]    show or switch working dir (resets session)
  /self  [on|off]  toggle self-edit mode (TUI only — REPL ignores)
  /commands        list installed slash commands (project + user + plugins)
  /skills          list installed skills (project + user + plugins)
  /compact         force ContextManager to run compact now
  /status          session id, cwd, context tokens, last turn cost

Anything else (/init, /agents, /review, /skill-name, plugin commands…)
is forwarded to the underlying SDK and handled by Claude Code's own
slash dispatcher.
`

function printBanner(opts: SDKSessionOptions): void {
  const lines = [
    c.bold('claude-sdk') + c.gray(' — patched Claude Agent SDK'),
    `${c.gray('model:')} ${opts.model}`,
    `${c.gray('cwd:')}   ${opts.cwd}`,
    c.gray('type your prompt, or /help for commands. Ctrl+D to exit.'),
    '',
  ]
  process.stdout.write(lines.join('\n') + '\n')
}
