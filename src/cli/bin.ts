#!/usr/bin/env bun
/**
 * `claude-sdk` CLI entry. Dispatches to one-shot, REPL, or HTTP server modes
 * based on argv. See `args.ts` for option list.
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.mode === 'help') {
    process.stdout.write(HELP_TEXT)
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
        systemPromptOverride: args.system,
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
    await runOneShot({
      prompt,
      model: args.model,
      system: args.system,
      cwd: args.cwd,
      maxTurns: args.maxTurns,
    })
    return
  }

  const piped = await readStdin()
  if (piped) {
    await runOneShot({
      prompt: piped,
      model: args.model,
      system: args.system,
      cwd: args.cwd,
      maxTurns: args.maxTurns,
    })
    return
  }

  await runRepl({
    model: args.model,
    system: args.system,
    cwd: args.cwd,
    maxTurns: args.maxTurns,
    watermarkTokens: args.watermark,
  })
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`claude-sdk: ${message}\n`)
  process.exit(1)
})
