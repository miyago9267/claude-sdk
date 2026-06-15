/**
 * Argv parser aligned with the official `claude` CLI.
 *
 * Coverage strategy: flags we honour come from the official CLI verbatim
 * (so muscle memory and Copilot-driven invocations carry over). Flags we
 * cannot back yet are accepted and reported as `unsupported` so scripts
 * fail loudly instead of silently ignoring options. Custom additions
 * (--ollama / --port / --host / --watermark) live alongside.
 */

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

export interface ParsedArgs {
  mode: 'ollama' | 'help' | 'version' | 'tui'
  prompt?: string

  model?: string
  systemPrompt?: string
  appendSystemPrompt?: string
  addDir?: string[]
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  allowDangerouslySkipPermissions?: boolean
  maxTurns?: number
  settingSources?: string[]
  resume?: string
  continue?: boolean
  debug?: string | true
  verbose?: boolean

  cwd?: string
  watermark?: number

  ollama?: boolean
  port?: number
  host?: string

  tui?: boolean

  unsupported: string[]
  raw: string[]
}

export const HELP_TEXT = `\
claude-sdk — subscription-backed Claude Agent SDK: library + OpenAI/Ollama bridge

This CLI is a launcher for two surfaces:
  --ollama   HTTP bridge (OpenAI-compat + Ollama-native) for harness frameworks
  --tui      bonus terminal front-end (hand-rolled; build first)

For everything else, import the library:
  import { ... } from '@miyago/claude-sdk'          # patched agent SDK
  import { serveOllamaBridge } from '@miyago/claude-sdk/ollama'

Usage:
  claude-sdk --ollama [options]
  claude-sdk --tui [options]

Bridge options:
      --port <n>                       Server port (default: 11434 or env PORT)
      --host <addr>                    Server bind address (default: 127.0.0.1)
      --model <id>                     Default model (alias or full ID, e.g. claude-sonnet-4-6)
      --cwd <path>                     Agent working directory (default: cwd)
      --system-prompt <text>           Override system prompt
      --permission-mode <mode>         default | acceptEdits | bypassPermissions | plan | dontAsk
      --allow-dangerously-skip-permissions
                                       Bypass all permission checks
      --max-turns <n>                  Max agent turns (default: 10)

TUI options (bonus):
      --watermark <n>                  ContextManager watermark tokens (default: 150000)
  -c, --continue                       Continue last conversation in this cwd
  -r, --resume <id>                    Resume by session ID (local or official)

Shared:
      --add-dir <dirs>                 Comma-separated extra working dirs
      --allowedTools <list>            Comma-separated tool allowlist (e.g. "Bash,Edit")
      --disallowedTools <list>         Comma-separated tool denylist
      --setting-sources <list>         Comma list: user,project,local (default: all three)
  -d, --debug [filter]                 Enable debug logs
      --verbose                        Verbose mode
  -h, --help                           Show this help
  -v, --version                        Show version

Examples:
  claude-sdk --ollama                  # bridge on 11434 (point any OpenAI/Ollama client here)
  claude-sdk --ollama --port 11500     # custom port
  claude-sdk --tui                     # bonus TUI (build: bash scripts/build-tui.sh)
`

const FLAGS_BOOLEAN = new Set([
  '-c', '--continue',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--verbose',
  '--ollama',
  '--tui',
  '-h', '--help',
  '-v', '--version',
])

const UNSUPPORTED = new Set([
  '--mcp-config', '--strict-mcp-config',
  '--agent', '--agents',
  '--bare', '--brief',
  '--chrome', '--no-chrome',
  '--ide',
  '--effort',
  '--betas',
  '--fallback-model',
  '--fork-session',
  '--from-pr',
  '--include-hook-events', '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--no-session-persistence',
  '--plugin-dir',
  '--remote-control-session-name-prefix',
  '--replay-user-messages',
  '--session-id',
  '--settings',
  '--tools',
  '--tmux',
  '--worktree', '-w',
  '--name', '-n',
  '--file',
  '--exclude-dynamic-system-prompt-sections',
  '--disable-slash-commands',
])

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: 'help', unsupported: [], raw: argv }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const takeValue = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Option ${a} requires a value`)
      return v
    }

    if (UNSUPPORTED.has(a)) {
      out.unsupported.push(a)
      if (!FLAGS_BOOLEAN.has(a)) i++
      continue
    }

    switch (a) {
      case '-h':
      case '--help':
        out.mode = 'help'
        break
      case '-v':
      case '--version':
        out.mode = 'version'
        break
      case '--model':
        out.model = takeValue()
        break
      case '--system-prompt':
        out.systemPrompt = takeValue()
        break
      case '--append-system-prompt':
        out.appendSystemPrompt = takeValue()
        break
      case '--add-dir':
        out.addDir = (out.addDir ?? []).concat(splitList(takeValue()))
        break
      case '--allowedTools':
      case '--allowed-tools':
        out.allowedTools = (out.allowedTools ?? []).concat(splitList(takeValue()))
        break
      case '--disallowedTools':
      case '--disallowed-tools':
        out.disallowedTools = (out.disallowedTools ?? []).concat(splitList(takeValue()))
        break
      case '--permission-mode':
        out.permissionMode = takeValue() as PermissionMode
        break
      case '--allow-dangerously-skip-permissions':
      case '--dangerously-skip-permissions':
        out.allowDangerouslySkipPermissions = true
        break
      case '--max-turns':
        out.maxTurns = Number(takeValue())
        break
      case '--setting-sources':
        out.settingSources = splitList(takeValue())
        break
      case '-r':
      case '--resume':
        out.resume = takeValue()
        break
      case '-c':
      case '--continue':
        out.continue = true
        break
      case '-d':
      case '--debug': {
        const next = argv[i + 1]
        if (next && !next.startsWith('-')) {
          out.debug = next
          i++
        } else {
          out.debug = true
        }
        break
      }
      case '--verbose':
        out.verbose = true
        break
      case '--cwd':
        out.cwd = takeValue()
        break
      case '--watermark':
        out.watermark = Number(takeValue())
        break
      case '--ollama':
        out.ollama = true
        break
      case '--tui':
        out.tui = true
        break
      case '--port':
        out.port = Number(takeValue())
        break
      case '--host':
        out.host = takeValue()
        break
      default:
        if (a.startsWith('--') || (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a))) {
          throw new Error(`Unknown option: ${a}`)
        }
        positional.push(a)
    }
  }

  if (out.mode === 'version') return out

  if (positional.length) out.prompt = positional.join(' ')

  if (out.ollama) out.mode = 'ollama'
  else if (out.tui) out.mode = 'tui'
  else out.mode = 'help'

  return out
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
