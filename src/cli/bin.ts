#!/usr/bin/env bun
/**
 * `claude-sdk` CLI entry. Args mirror the official `claude` CLI where
 * possible; see `src/cli/args.ts` for the full surface.
 *
 * Dispatch:
 *   --help / --version          → print and exit
 *   --serve                     → OpenAI HTTP adapter
 *   -p / --print or stdin pipe  → one-shot
 *   prompt arg without -p       → REPL with seeded first turn (matches
 *                                 official behaviour)
 *   no args + TTY               → REPL
 */

import { HELP_TEXT, parseArgs } from './args.ts'
import { runOneShot } from './runner.ts'
import { runRepl } from './repl.ts'

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

function printVersion(): void {
  try {
    const pkg = require('../../package.json') as { version?: string }
    process.stdout.write(`claude-sdk ${pkg.version ?? '0.0.0'}\n`)
  } catch {
    process.stdout.write('claude-sdk (unknown version)\n')
  }
}

function warnUnsupported(args: ReturnType<typeof parseArgs>): void {
  if (!args.unsupported.length) return
  process.stderr.write(
    `claude-sdk: ignoring unsupported option(s): ${args.unsupported.join(', ')}\n`,
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.mode === 'help') {
    process.stdout.write(HELP_TEXT)
    return
  }

  if (args.mode === 'version') {
    printVersion()
    return
  }

  warnUnsupported(args)

  if (args.continue || args.resume) {
    process.stderr.write(
      'claude-sdk: -c / --resume not implemented yet (V2 sessions are not persisted to disk). Continuing as new session.\n',
    )
  }

  if (args.mode === 'tui') {
    const { runTui } = await import('./tui.ts')
    await runTui({ args })
    return
  }

  if (args.mode === 'serve') {
    const { serveOpenAIAdapter } = await import('../openai/server.ts')
    const handle = serveOpenAIAdapter({
      port: args.port,
      hostname: args.host,
      config: {
        defaultModel: args.model,
        cwd: args.cwd,
        systemPromptOverride: args.systemPrompt,
        permissionMode: args.permissionMode,
        allowDangerouslySkipPermissions: args.allowDangerouslySkipPermissions,
        maxTurns: args.maxTurns,
      },
    })
    process.stdout.write(`OpenAI adapter listening on ${handle.url}\n`)
    process.stdout.write(`  POST ${handle.url}/v1/chat/completions\n`)
    process.stdout.write(`  GET  ${handle.url}/v1/models\n`)
    const stop = () => {
      handle.stop()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  if (args.mode === 'oneshot') {
    const piped = args.prompt ? '' : await readStdin()
    const prompt = args.prompt ?? piped
    if (!prompt) {
      process.stderr.write('No prompt provided. See --help.\n')
      process.exit(2)
    }
    await runOneShot({ prompt, args })
    return
  }

  const piped = await readStdin()
  if (piped) {
    await runOneShot({ prompt: piped, args })
    return
  }

  await runRepl({ args, seedPrompt: args.prompt })
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`claude-sdk: ${message}\n`)
  process.exit(1)
})
