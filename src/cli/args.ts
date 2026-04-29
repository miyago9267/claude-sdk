/**
 * Lightweight argv parser. Avoids external deps. Supports:
 *   <prompt>                   positional, becomes one-shot prompt
 *   -p, --print  <prompt>      same as positional
 *   -m, --model  <id>          model alias or full ID
 *   -s, --system <text>        system prompt
 *       --cwd    <path>        working dir
 *       --max-turns <n>        SDK maxTurns
 *       --watermark <tokens>   ContextManager watermark (default 150000)
 *       --serve                start OpenAI HTTP server, ignore prompt
 *       --port   <n>           HTTP port (default 4141, env PORT)
 *       --host   <addr>        HTTP host (default 127.0.0.1)
 *   -h, --help
 */

export interface ParsedArgs {
  mode: 'oneshot' | 'repl' | 'serve' | 'help'
  prompt?: string
  model?: string
  system?: string
  cwd?: string
  maxTurns?: number
  watermark?: number
  port?: number
  host?: string
  help?: boolean
  raw: string[]
}

export const HELP_TEXT = `\
claude-sdk — patched Claude Agent SDK CLI

Usage:
  claude-sdk [options] [prompt]
  claude-sdk --serve [options]

Options:
  -p, --print <prompt>     One-shot prompt (alternative to positional arg)
  -m, --model <id>         Model alias or full ID (default: claude-sonnet-4-6)
  -s, --system <text>      System prompt
      --cwd <path>         Working directory (default: cwd)
      --max-turns <n>      Max agent turns (default: 10)
      --watermark <n>      ContextManager watermark tokens (default: 150000)
      --serve              Run OpenAI Chat Completions HTTP server
      --port <n>           Server port (default: 4141, or env PORT)
      --host <addr>        Server bind address (default: 127.0.0.1)
  -h, --help               Show this help

Examples:
  claude-sdk "Explain this repo"
  claude-sdk -m claude-haiku-4-5 -p "What is 2+2?"
  echo "Summarise" | claude-sdk
  claude-sdk --serve --port 4141
`

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: 'repl', raw: argv }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    switch (a) {
      case '-h':
      case '--help':
        out.help = true
        break
      case '-p':
      case '--print':
        out.prompt = argv[++i]
        break
      case '-m':
      case '--model':
        out.model = argv[++i]
        break
      case '-s':
      case '--system':
        out.system = argv[++i]
        break
      case '--cwd':
        out.cwd = argv[++i]
        break
      case '--max-turns':
        out.maxTurns = Number(argv[++i])
        break
      case '--watermark':
        out.watermark = Number(argv[++i])
        break
      case '--serve':
        out.mode = 'serve'
        break
      case '--port':
        out.port = Number(argv[++i])
        break
      case '--host':
        out.host = argv[++i]
        break
      default:
        if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`)
        positional.push(a)
    }
  }

  if (out.help) {
    out.mode = 'help'
    return out
  }
  if (out.mode === 'serve') return out

  if (!out.prompt && positional.length) out.prompt = positional.join(' ')
  if (out.prompt !== undefined) out.mode = 'oneshot'

  return out
}
