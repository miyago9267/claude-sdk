/**
 * Argv parser aligned with the official `claude` CLI.
 *
 * Coverage strategy: flags we honour come from the official CLI verbatim
 * (so muscle memory and Copilot-driven invocations carry over). Flags we
 * cannot back yet are accepted and reported as `unsupported` so scripts
 * fail loudly instead of silently ignoring options. Custom additions
 * (--serve / --port / --host / --watermark) live alongside.
 */

export type OutputFormat = 'text' | 'json' | 'stream-json'
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'

export interface ParsedArgs {
  mode: 'oneshot' | 'repl' | 'serve' | 'help' | 'version' | 'tui'
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
  outputFormat?: OutputFormat
  print?: boolean
  resume?: string
  continue?: boolean
  debug?: string | true
  verbose?: boolean

  cwd?: string
  watermark?: number

  serve?: boolean
  port?: number
  host?: string

  tui?: boolean

  unsupported: string[]
  raw: string[]
}

export const HELP_TEXT = `\
claude-sdk — patched Claude Agent SDK with OpenAI adapter

Usage:
  claude-sdk [options] [prompt]
  claude-sdk --serve [options]
  claude-sdk -p [options] [prompt]

Common options (mirrors official \`claude\` CLI):
  -p, --print                          Print response and exit (no REPL)
      --model <id>                     Model alias or full ID (e.g. sonnet, claude-sonnet-4-6)
      --system-prompt <text>           Override system prompt
      --append-system-prompt <text>    Append to default system prompt
      --add-dir <dirs>                 Comma-separated extra working dirs
      --allowedTools <list>            Comma-separated tool allowlist (e.g. "Bash,Edit")
      --disallowedTools <list>         Comma-separated tool denylist
      --permission-mode <mode>         default | acceptEdits | bypassPermissions | plan | dontAsk
      --allow-dangerously-skip-permissions
                                       Bypass all permission checks
      --max-turns <n>                  Max agent turns (default: 10)
      --setting-sources <list>         Comma list: user,project,local (default: all three)
      --output-format <fmt>            text | json | stream-json (only with -p)
  -c, --continue                       (planned) Continue last conversation
  -r, --resume <id>                    (planned) Resume by session ID
  -d, --debug [filter]                 Enable debug logs
      --verbose                        Verbose mode

Custom (claude-sdk additions):
      --cwd <path>                     Working directory (default: cwd)
      --watermark <n>                  ContextManager watermark tokens (default: 150000)
      --tui                            Launch bubbletea TUI front-end
                                       (build first: bash scripts/build-tui.sh)
      --serve                          Run OpenAI Chat Completions HTTP server
      --port <n>                       Server port (default: 4141 or env PORT)
      --host <addr>                    Server bind address (default: 127.0.0.1)

  -h, --help                           Show this help
  -v, --version                        Show version

Examples:
  claude-sdk                           # interactive REPL
  claude-sdk "Explain this repo"       # interactive with seed prompt
  claude-sdk -p "What is 2+2?"         # one-shot
  claude-sdk -p --output-format json "Summarise" | jq .
  echo "Summarise" | claude-sdk -p
  claude-sdk --serve --port 4141       # OpenAI-compatible HTTP endpoint
`

const FLAGS_BOOLEAN = new Set([
  '-p', '--print',
  '-c', '--continue',
  '--allow-dangerously-skip-permissions',
  '--dangerously-skip-permissions',
  '--verbose',
  '--serve',
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
  const out: ParsedArgs = { mode: 'repl', unsupported: [], raw: argv }
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
      case '-p':
      case '--print':
        out.print = true
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
      case '--output-format':
        out.outputFormat = takeValue() as OutputFormat
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
      case '--serve':
        out.serve = true
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

  if (out.mode === 'help' || out.mode === 'version') return out

  if (positional.length) out.prompt = positional.join(' ')

  if (out.serve) out.mode = 'serve'
  else if (out.tui) out.mode = 'tui'
  else if (out.print) out.mode = 'oneshot'
  else if (out.prompt !== undefined) out.mode = 'oneshot'
  else out.mode = 'repl'

  return out
}

function splitList(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}
