#!/usr/bin/env bun
/**
 * `claude-sdk` CLI entry — a thin launcher for the two runtime surfaces.
 * Everything else (the patched agent SDK, context manager, bridge) is
 * consumed by importing the library; see package.json `exports`.
 *
 * Dispatch:
 *   --help / --version   → print and exit
 *   --ollama             → OpenAI-compat + Ollama-native HTTP bridge
 *   --tui                → bonus bubbletea terminal front-end
 *   (anything else)      → help
 */

import { HELP_TEXT, parseArgs } from './args.ts'
import { SessionStore, type SessionMeta } from './session-store.ts'
import { OfficialResolver, type OfficialMeta } from './official-session.ts'

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

/**
 * Resolve a resume target for the TUI from two sources — our own
 * ~/.claude-sdk/sessions/ (local store) and the official ~/.claude/projects/
 * layout. An official-only hit is mirrored into the local index so the same
 * id chains both files going forward. Returns the logical session id to seed.
 */
function resolveResume(args: ReturnType<typeof parseArgs>, store: SessionStore, official: OfficialResolver): string | undefined {
  const cwd = args.cwd ?? process.cwd()
  let resumeMeta: SessionMeta | null = null
  let resumeSource: 'local' | 'official' | null = null
  let officialMeta: OfficialMeta | null = null

  if (args.resume) {
    resumeMeta = store.get(args.resume)
    if (resumeMeta) {
      resumeSource = 'local'
    } else {
      officialMeta = official.findById(args.resume)
      if (officialMeta) {
        resumeSource = 'official'
      } else {
        process.stderr.write(`claude-sdk: no session with id "${args.resume}" (checked local + official)\n`)
        process.exit(2)
      }
    }
  } else if (args.continue) {
    const local = store.findLatestByCwd(cwd)
    const off = official.findLatestByCwd(cwd)
    if (!local && !off) {
      process.stderr.write(`claude-sdk: no previous session in this cwd to continue\n`)
      process.exit(2)
    }
    if (local && (!off || local.lastUsedAt >= off.lastUsedAt)) {
      resumeMeta = local
      resumeSource = 'local'
    } else if (off) {
      officialMeta = off
      resumeSource = 'official'
    }
  }

  if (resumeSource === 'official' && officialMeta) {
    resumeMeta = store.create({
      cwd: officialMeta.cwd || cwd,
      model: officialMeta.model ?? args.model ?? 'claude-sonnet-4-6',
      id: officialMeta.id,
    })
    const officialTurns = official.loadTurns(officialMeta.jsonlPath)
    store.importRawTurns(officialMeta.id, officialTurns)
    process.stderr.write(
      `claude-sdk: importing official session ${officialMeta.id} (${officialTurns.length} turns)\n`,
    )
  } else if (resumeMeta) {
    process.stderr.write(
      `claude-sdk: resuming session ${resumeMeta.id} (${resumeMeta.turnCount} turns)\n`,
    )
  }

  return resumeMeta?.id
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.mode === 'version') {
    printVersion()
    return
  }

  if (args.mode === 'help') {
    process.stdout.write(HELP_TEXT)
    return
  }

  warnUnsupported(args)

  if (args.mode === 'ollama') {
    const { serveOllamaBridge } = await import('../ollama/server.ts')
    const handle = serveOllamaBridge({
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
    process.stdout.write(`Ollama bridge listening on ${handle.url}\n`)
    process.stdout.write(`  GET  ${handle.url}/api/tags\n`)
    process.stdout.write(`  POST ${handle.url}/api/show\n`)
    process.stdout.write(`  POST ${handle.url}/api/chat\n`)
    process.stdout.write(`  POST ${handle.url}/v1/chat/completions  (OpenAI-compat)\n`)
    const stop = () => {
      handle.stop()
      process.exit(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    return
  }

  if (args.mode === 'tui') {
    const official = new OfficialResolver()
    const store = new SessionStore({ official })
    const logicalSessionId = resolveResume(args, store, official)
    const { runTui } = await import('./tui.ts')
    await runTui({ args, store, logicalSessionId })
    return
  }

  process.stdout.write(HELP_TEXT)
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`claude-sdk: ${message}\n`)
  process.exit(1)
})
