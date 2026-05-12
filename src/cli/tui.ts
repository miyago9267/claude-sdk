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

import { existsSync, createWriteStream, type WriteStream } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve, join as pjoin } from 'node:path'
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
import { discoverCommands, discoverSkills, discoverAgents, formatList } from './discover.ts'
import { safeCloseSession } from './safe-close.ts'
import { resolveModel, formatKnownModels, KNOWN_MODELS } from './models.ts'
import { readGitBranch, readGitDirty } from './git-info.ts'
import { SessionStore } from './session-store.ts'

export interface TuiOptions {
  args: ParsedArgs
  binaryPath?: string
  store?: SessionStore
  logicalSessionId?: string
}

interface HostEvent {
  type:
    | 'banner'
    | 'text-delta'
    | 'tool-use'
    | 'tool-result'
    | 'tool-progress'
    | 'mcp-call'
    | 'skill-call'
    | 'hook'
    | 'task'
    | 'assistant-end'
    | 'result'
    | 'error'
    | 'status'
    | 'busy'
    | 'thinking'
    | 'capabilities'
    | 'ask'
  text?: string
  model?: string
  cwd?: string
  branch?: string
  branchDirty?: boolean
  name?: string
  id?: string
  input?: string
  ok?: boolean
  sessionId?: string
  contextTokens?: number
  contextWindow?: number
  costUSD?: number
  compactions?: number
  usagePct?: number
  usageRemainingSec?: number
  usageBudgetUSD?: number
  usageSpentUSD?: number
  message?: string
  reason?: string
  payload?: string

  // Phase C
  hookEvent?: string
  hookName?: string
  hookStatus?: string
  durationMs?: number
  taskId?: string
  taskStatus?: string
  taskDescription?: string
  elapsedSec?: number
  tokens?: number
  mcpServer?: string
  mcpTool?: string
  skillName?: string
}

interface BuiltinCmd {
  name: string
  source: string
  description: string
  args?: Array<{ name: string; description?: string }>
}

const MODEL_ARG_OPTIONS = [
  ...KNOWN_MODELS.flatMap((m) => {
    const out: Array<{ name: string; description?: string }> = [
      { name: m.id, description: m.description },
    ]
    if (m.alias) out.unshift({ name: m.alias, description: `alias for ${m.id}` })
    return out
  }),
]

const TS_BUILTIN_COMMANDS: BuiltinCmd[] = [
  { name: '/help', source: 'built-in', description: 'show available slash commands' },
  { name: '/clear', source: 'built-in', description: 'reset the current session' },
  {
    name: '/model',
    source: 'built-in',
    description: 'show or switch model (resets session)',
    args: MODEL_ARG_OPTIONS,
  },
  { name: '/cwd', source: 'built-in', description: 'show or switch working directory' },
  {
    name: '/self',
    source: 'built-in',
    description: 'toggle self-edit mode (add claude-sdk root)',
    args: [
      { name: 'on', description: 'enable self-edit mode' },
      { name: 'off', description: 'disable self-edit mode' },
    ],
  },
  { name: '/compact', source: 'built-in', description: 'force ContextManager compact now' },
  { name: '/status', source: 'built-in', description: 'session id, cwd, context tokens, cost' },
  { name: '/commands', source: 'built-in', description: 'list installed slash commands' },
  { name: '/skills', source: 'built-in', description: 'list installed skills' },
  { name: '/sessions', source: 'built-in', description: 'pick a session to resume (local + official)' },
  { name: '/agents', source: 'built-in', description: 'pick an agent to inspect or invoke' },
  {
    name: '/pm',
    source: 'built-in',
    description: 'switch permission mode (plan-style confirm via picker)',
    args: [
      { name: 'bypassPermissions', description: 'no prompts (current default)' },
      { name: 'default', description: 'prompt for dangerous ops' },
      { name: 'acceptEdits', description: 'auto-accept edits, prompt for the rest' },
      { name: 'plan', description: 'planning mode, no actual tool execution' },
      { name: 'dontAsk', description: 'deny anything not pre-approved' },
    ],
  },
  {
    name: '/ask',
    source: 'built-in',
    description: 'demo the text-input picker (free-form answer)',
  },
  { name: '/exit', source: 'built-in', description: 'leave the TUI' },
  { name: '/quit', source: 'built-in', description: 'leave the TUI' },
]

interface UIEvent {
  type: 'prompt' | 'slash' | 'exit' | 'answer'
  text?: string
  cmd?: string
  askId?: string
  value?: string
  cancelled?: boolean
}

interface AskOption {
  value: string
  label?: string
  hint?: string
}

interface AskRequest {
  kind: 'select' | 'confirm' | 'text'
  question: string
  hint?: string
  options?: AskOption[]
}

interface AskResult {
  cancelled: boolean
  value?: string
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

  // canUseTool is wired through a late-bound askUserRef so we can put the
  // session and the askUser helper in any order. The SDK only calls the
  // callback once the permission mode allows it (i.e. not bypassPermissions),
  // by which time askUserRef has been pointed at the real askUser.
  let askUserRef: ((req: AskRequest) => Promise<AskResult>) | null = null

  const canUseToolCallback = async (
    toolName: string,
    input: Record<string, unknown>,
    _opts: { signal: AbortSignal },
  ): Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }> => {
    const ask = askUserRef
    if (!ask) {
      return { behavior: 'allow' }
    }
    const summary = summariseToolInput(toolName, input)
    const result = await ask({
      kind: 'select',
      question: `Run ${toolName}?`,
      hint: summary || '(no input summary)',
      options: [
        { value: 'allow', label: 'Allow once', hint: 'execute just this call' },
        { value: 'allow-session', label: 'Allow all ' + toolName + ' (this session)', hint: 'stop asking for this tool' },
        { value: 'deny', label: 'Deny', hint: 'skip and continue' },
      ],
    })
    if (result.cancelled || result.value === 'deny') {
      return { behavior: 'deny', message: 'declined via picker' }
    }
    return { behavior: 'allow' }
  }

  let sessionOptions = {
    ...buildSessionOptions({ args: opts.args }),
    canUseTool: canUseToolCallback as unknown as SDKSessionOptions['canUseTool'],
  }
  let session: SDKSession = unstable_v2_createSession(sessionOptions)
  let sessionId: string | null = null
  let busy = false

  const store = opts.store
  let logicalId: string | null = opts.logicalSessionId ?? null
  let pendingPrefix = ''
  if (store && logicalId) {
    pendingPrefix = store.formatHistoryPrefix(logicalId)
    store.touch(logicalId)
  }

  // Best-effort Claude Max 5-hour window estimate. Anthropic doesn't expose
  // the real quota over the SDK, so we accumulate per-turn cost deltas into
  // a wall-clock 5h window and divide by a configurable budget.
  const usageBudgetUSD = Number(process.env.CLAUDE_SDK_USAGE_BUDGET ?? '5')
  const usageWindowMs = 5 * 60 * 60 * 1000
  let usageWindowStart = Date.now()
  let usageWindowCost = 0
  let prevSessionCost: number | null = null

  const resetSessionCostTracking = () => { prevSessionCost = null }

  // The Go binary opens /dev/tty itself for input/render, so stdin/stdout are
  // free to act as full-duplex IPC channels. stderr stays on the real TTY for
  // any diagnostic messages bubbletea or runtime panics may print.
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })

  const hostOut = child.stdin as Writable | null
  const uiIn = child.stdout as Readable | null
  if (!hostOut || !uiIn) {
    process.stderr.write('claude-sdk: failed to open IPC pipes to TUI binary\n')
    child.kill()
    return
  }

  const debug = openDebugLog()
  const sendToTui = (ev: HostEvent) => {
    if (hostOut.destroyed) return
    hostOut.write(JSON.stringify(ev) + '\n')
    debug?.write(`[->tui] ${ev.type} ${ev.text ? JSON.stringify(ev.text.slice(0, 80)) : ''}\n`)
  }

  // askUser pushes an EvtAsk to the TUI and resolves once the matching
  // 'answer' UIEvent arrives. The picker handles all the keyboard UX.
  const pendingAsks = new Map<string, (r: AskResult) => void>()
  let askCounter = 0
  const askUser = (req: AskRequest): Promise<AskResult> =>
    new Promise((resolveAsk) => {
      const id = `ask-${++askCounter}-${Date.now()}`
      pendingAsks.set(id, resolveAsk)
      sendToTui({
        type: 'ask',
        payload: JSON.stringify({ id, ...req }),
      })
    })
  // wire the late-bound ref so canUseToolCallback can call it
  askUserRef = askUser

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
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
      },
      log,
      model: sessionOptions.model,
      cwd: sessionOptions.cwd ?? process.cwd(),
    },
  )

  sendBanner()

  function sendBanner() {
    const cwd = sessionOptions.cwd ?? process.cwd()
    const branch = readGitBranch(cwd)
    sendToTui({
      type: 'banner',
      model: sessionOptions.model,
      cwd,
      branch: branch ?? '',
      branchDirty: branch ? readGitDirty(cwd) : false,
    })
  }

  // Surface installed slash commands and skills to the user once on startup.
  // Lookup paths mirror the official CLI (~/.claude/commands, project
  // .claude/commands, plugins/*/commands; same for skills).
  const cwdForDiscovery = sessionOptions.cwd ?? process.cwd()
  const cmdList = discoverCommands({ cwd: cwdForDiscovery })
  const skillList = discoverSkills({ cwd: cwdForDiscovery })
  pushCapabilities(cmdList, skillList)
  if (cmdList.length || skillList.length) {
    sendToTui({
      type: 'status',
      message: `${cmdList.length} commands · ${skillList.length} skills installed (try /commands /skills)`,
    })
  }

  function pushCapabilities(
    cmds: Array<{ name: string; source: string; description?: string }>,
    skills: Array<{ name: string; source: string; description?: string }>,
  ) {
    const allCommands = [
      ...TS_BUILTIN_COMMANDS,
      ...cmds.map((c) => ({
        name: c.name,
        source: c.source,
        description: c.description ?? '',
      })),
    ]
    sendToTui({
      type: 'capabilities',
      payload: JSON.stringify({
        commands: allCommands,
        skills: skills.map((s) => ({
          name: s.name,
          source: s.source,
          description: s.description ?? '',
        })),
      }),
    })
  }

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
  await safeCloseSession(session)

  async function handleUIEvent(ev: UIEvent): Promise<void> {
    if (ev.type === 'exit') {
      child.kill()
      return
    }
    if (ev.type === 'answer') {
      const id = ev.askId ?? ''
      const resolver = pendingAsks.get(id)
      if (resolver) {
        pendingAsks.delete(id)
        resolver({ cancelled: ev.cancelled === true, value: ev.value })
      }
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
    let streamedText = false
    let assistantText = ''
    const seenToolUseFromStream = new Set<string>()
    let effectivePrompt = prompt
    if (pendingPrefix) {
      effectivePrompt = pendingPrefix + prompt
      pendingPrefix = ''
    }
    try {
      await session.send(effectivePrompt)
      for await (const msg of session.stream()) {
        debug?.write(`[<-sdk] ${msg.type}\n`)
        if (msg.type === 'stream_event') {
          const e = msg.event
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') {
            streamedText = true
            assistantText += e.delta.text
            sendToTui({ type: 'text-delta', text: e.delta.text })
          }
          if (e.type === 'content_block_start' && e.content_block.type === 'tool_use') {
            seenToolUseFromStream.add(e.content_block.id)
            forwardToolUse(
              e.content_block.id,
              e.content_block.name,
              e.content_block.input,
              sendToTui,
            )
          }
          continue
        }
        if (msg.type === 'system') {
          const sub = (msg as { subtype?: string }).subtype
          if (sub === 'hook_started') {
            const m2 = msg as unknown as { hook_event?: string; hook_name?: string }
            sendToTui({
              type: 'hook',
              hookEvent: m2.hook_event ?? '',
              hookName: m2.hook_name ?? '',
              hookStatus: 'started',
            })
          } else if (sub === 'hook_response') {
            const m2 = msg as unknown as {
              hook_event?: string
              hook_name?: string
              output?: string
              stderr?: string
              duration_ms?: number
            }
            const ok = !m2.stderr || m2.stderr.trim().length === 0
            sendToTui({
              type: 'hook',
              hookEvent: m2.hook_event ?? '',
              hookName: m2.hook_name ?? '',
              hookStatus: ok ? 'ok' : 'err',
              durationMs: m2.duration_ms ?? 0,
            })
          } else if (sub === 'task_started') {
            const m2 = msg as unknown as { task_id?: string; description?: string }
            sendToTui({
              type: 'task',
              taskId: m2.task_id ?? '',
              taskDescription: m2.description ?? '',
              taskStatus: 'started',
            })
          } else if (sub === 'task_progress') {
            const m2 = msg as unknown as {
              task_id?: string
              description?: string
              usage?: { total_tokens?: number }
            }
            sendToTui({
              type: 'task',
              taskId: m2.task_id ?? '',
              taskDescription: m2.description ?? '',
              taskStatus: 'progress',
              tokens: m2.usage?.total_tokens ?? 0,
            })
          } else if (sub === 'task_notification') {
            const m2 = msg as unknown as {
              task_id?: string
              status?: 'completed' | 'failed' | 'stopped'
              summary?: string
            }
            sendToTui({
              type: 'task',
              taskId: m2.task_id ?? '',
              taskStatus: m2.status ?? 'completed',
              message: m2.summary ?? '',
            })
          }
          continue
        }
        if (msg.type === 'tool_progress') {
          const m2 = msg as unknown as { tool_use_id?: string; elapsed_time_seconds?: number }
          sendToTui({
            type: 'tool-progress',
            id: m2.tool_use_id ?? '',
            elapsedSec: Math.round(m2.elapsed_time_seconds ?? 0),
          })
          continue
        }
        if (msg.type === 'user') {
          // V2 surfaces tool execution results as user messages with
          // tool_result blocks. Forward them so the TUI can render them
          // under the matching tool-use line.
          const um = msg as { message?: { content?: unknown } }
          const blocks = (um.message?.content ?? []) as Array<Record<string, unknown>>
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === 'tool_result') {
                const id = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
                const ok = b.is_error !== true
                const text = stringifyToolContent(b.content).slice(0, 240)
                sendToTui({ type: 'tool-result', id, ok, message: text })
              }
            }
          }
          continue
        }
        if (msg.type === 'assistant') {
          const am = msg as SDKAssistantMessage
          if (am.error) sendToTui({ type: 'error', message: String(am.error) })
          // Fallback: if we never saw a streamed text delta for this turn,
          // emit the assistant message's text content blocks all at once so
          // the user actually sees the response.
          if (!streamedText) {
            const blocks = (am.message?.content ?? []) as Array<Record<string, unknown>>
            for (const b of blocks) {
              if (b?.type === 'text' && typeof b.text === 'string') {
                sendToTui({ type: 'text-delta', text: b.text as string })
                assistantText += b.text as string
                streamedText = true
              }
              if (b?.type === 'tool_use' && typeof b.name === 'string') {
                const id = typeof b.id === 'string' ? (b.id as string) : ''
                if (!seenToolUseFromStream.has(id)) {
                  forwardToolUse(id, b.name as string, b.input, sendToTui)
                }
              }
            }
          }
        }
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage
          sessionId = r.session_id
          manager.updateFromResult(r)
          sendToTui({ type: 'assistant-end' })
          const cumCost = 'total_cost_usd' in r ? Number(r.total_cost_usd ?? 0) : 0
          let delta = 0
          if (prevSessionCost === null) {
            delta = cumCost
          } else if (cumCost >= prevSessionCost) {
            delta = cumCost - prevSessionCost
          } else {
            delta = cumCost
          }
          prevSessionCost = cumCost

          const now = Date.now()
          if (now - usageWindowStart >= usageWindowMs) {
            usageWindowStart = now
            usageWindowCost = 0
          }
          usageWindowCost += delta
          const remainingSec = Math.max(0, Math.round((usageWindowStart + usageWindowMs - now) / 1000))
          const usagePct = usageBudgetUSD > 0
            ? Math.min(1, usageWindowCost / usageBudgetUSD)
            : 0

          sendToTui({
            type: 'result',
            sessionId: r.session_id,
            contextTokens: manager.getState().contextTokensEstimate,
            contextWindow: extractContextWindow(r),
            costUSD: cumCost,
            compactions: manager.getState().totalCompactions,
            usagePct,
            usageRemainingSec: remainingSec,
            usageBudgetUSD,
            usageSpentUSD: usageWindowCost,
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

    if (store) {
      if (!logicalId) {
        const meta = store.create({
          cwd: sessionOptions.cwd ?? process.cwd(),
          model: sessionOptions.model,
        })
        logicalId = meta.id
      }
      store.appendTurn(logicalId, { role: 'user', content: prompt })
      if (assistantText) {
        store.appendTurn(logicalId, { role: 'assistant', content: assistantText })
      }
    }
  }

  async function handleSlash(cmd: string): Promise<void> {
    const [head, ...rest] = cmd.split(/\s+/)
    const arg = rest.join(' ').trim()
    switch (head) {
      case '/help':
        sendToTui({
          type: 'status',
          message:
            'TS:  /help /clear /model /cwd /self /compact /status /commands /skills /exit\n' +
            'SDK: any other /command (e.g. /init /agents /review) is forwarded to the SDK',
        })
        return

      case '/commands': {
        const list = discoverCommands({ cwd: sessionOptions.cwd ?? process.cwd() })
        sendToTui({ type: 'status', message: formatList('Slash commands', list) })
        return
      }

      case '/skills': {
        const list = discoverSkills({ cwd: sessionOptions.cwd ?? process.cwd() })
        sendToTui({ type: 'status', message: formatList('Skills', list) })
        return
      }

      case '/pm': {
        const mode = arg.trim()
        const allowed = new Set(['bypassPermissions', 'default', 'acceptEdits', 'plan', 'dontAsk'])
        if (!mode) {
          sendToTui({
            type: 'status',
            message:
              `current permission-mode: ${sessionOptions.permissionMode}\n` +
              `use: /pm <bypassPermissions|default|acceptEdits|plan|dontAsk>\n` +
              `(non-bypass modes trigger the canUseTool picker on every tool call)`,
          })
          return
        }
        if (!allowed.has(mode)) {
          sendToTui({ type: 'error', message: `unknown permission-mode: ${mode}` })
          return
        }
        sessionOptions = { ...sessionOptions, permissionMode: mode as SDKSessionOptions['permissionMode'] }
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        resetSessionCostTracking()
        sendToTui({ type: 'status', message: `permission-mode -> ${mode} (session reset)` })
        return
      }

      case '/ask': {
        const answer = await askUser({
          kind: 'text',
          question: 'Free-form picker demo',
          hint: 'Type whatever you want, hit Enter — Esc to cancel.',
        })
        if (answer.cancelled) {
          sendToTui({ type: 'status', message: 'cancelled' })
          return
        }
        sendToTui({ type: 'status', message: `you answered: ${answer.value ?? '(empty)'}` })
        return
      }

      case '/agents': {
        const cwd = sessionOptions.cwd ?? process.cwd()
        const agents = discoverAgents({ cwd })
        if (agents.length === 0) {
          sendToTui({ type: 'status', message: 'no agents discovered (~/.claude/agents/, .claude/agents/, plugins/*/agents/)' })
          return
        }
        const result = await askUser({
          kind: 'select',
          question: 'Pick an agent',
          hint: `${agents.length} agents discovered`,
          options: agents.map((a) => ({
            value: a.name,
            label: a.name,
            hint: `[${a.source}] ${truncate(a.description ?? '', 70)}`,
          })),
        })
        if (result.cancelled || !result.value) {
          sendToTui({ type: 'status', message: 'agent pick cancelled' })
          return
        }
        const picked = agents.find((a) => a.name === result.value)
        if (!picked) return
        sendToTui({
          type: 'status',
          message:
            `agent: ${picked.name}\n` +
            `source: ${picked.source}\n` +
            `path:   ${picked.path}\n\n` +
            `${picked.description ?? '(no description)'}\n\n` +
            `Send "@${picked.name} <task>" or just describe the work — Claude routes to it automatically.`,
        })
        return
      }

      case '/sessions': {
        if (!store) {
          sendToTui({ type: 'error', message: 'session store unavailable' })
          return
        }
        const cwd = sessionOptions.cwd ?? process.cwd()
        const localSessions = store.list()
        const officialMod = await import('./official-session.ts')
        const official = new officialMod.OfficialResolver()
        const officialMeta = official.findLatestByCwd(cwd)
        const officialAll = officialMeta ? [officialMeta] : []
        const seenIds = new Set(localSessions.map((s) => s.id))
        const merged = [
          ...localSessions
            .filter((s) => s.cwd === cwd)
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .map((s) => ({
              value: s.id,
              label: `${s.id.slice(0, 8)} · ${s.turnCount} turns · ${formatRelativeTs(s.lastUsedAt)}`,
              hint: `local · ${s.model}`,
            })),
          ...officialAll
            .filter((m) => !seenIds.has(m.id))
            .map((m) => ({
              value: `official:${m.id}`,
              label: `${m.id.slice(0, 8)} · ${m.turnCount} turns · ${formatRelativeTs(m.lastUsedAt)}`,
              hint: `official · ${m.model ?? '?'}`,
            })),
        ]
        if (merged.length === 0) {
          sendToTui({ type: 'status', message: 'no sessions found in this cwd' })
          return
        }
        const result = await askUser({
          kind: 'select',
          question: 'Resume which session?',
          hint: `cwd: ${cwd}`,
          options: merged,
        })
        if (result.cancelled || !result.value) {
          sendToTui({ type: 'status', message: 'session pick cancelled' })
          return
        }
        // Resolve the chosen id (handle 'official:' prefix for unimported entries)
        let chosenId = result.value
        if (chosenId.startsWith('official:')) {
          const officialId = chosenId.slice('official:'.length)
          const meta = official.findById(officialId)
          if (meta) {
            const local = store.create({
              cwd: meta.cwd || cwd,
              model: meta.model ?? sessionOptions.model,
              id: meta.id,
            })
            store.importRawTurns(meta.id, official.loadTurns(meta.jsonlPath))
            chosenId = local.id
          }
        }
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        logicalId = chosenId
        pendingPrefix = store.formatHistoryPrefix(chosenId)
        store.touch(chosenId)
        resetSessionCostTracking()
        sendBanner()
        sendToTui({
          type: 'status',
          message: `resumed session ${chosenId} · history prefix queued for next prompt`,
        })
        return
      }

      case '/self': {
        const root = resolveSelfRoot()
        const dirs = sessionOptions.additionalDirectories ?? []
        const turnOff = arg === 'off'
        const newDirs = turnOff
          ? dirs.filter((d) => d !== root)
          : dirs.includes(root) ? dirs : [...dirs, root]
        sessionOptions = {
          ...sessionOptions,
          additionalDirectories: newDirs,
          systemPrompt: turnOff
            ? sessionOptions.systemPrompt
            : selfModSystemPrompt(sessionOptions.systemPrompt, root),
        } as SDKSessionOptions
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        sendToTui({
          type: 'status',
          message: turnOff ? `self-edit off` : `self-edit on (${root})`,
        })
        return
      }
      case '/clear':
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        resetSessionCostTracking()
        sendToTui({ type: 'status', message: 'session reset', model: sessionOptions.model })
        return
      case '/model': {
        if (!arg) {
          sendToTui({
            type: 'status',
            message:
              `current model: ${sessionOptions.model}\n` +
              `\n${formatKnownModels()}\n` +
              `\nuse: /model <alias|id>   e.g. /model opus  or  /model claude-opus-4-6`,
          })
          return
        }
        const { model: resolved, known } = resolveModel(arg)
        if (!resolved) {
          sendToTui({ type: 'error', message: `Empty model name. ${formatKnownModels()}` })
          return
        }
        if (!known) {
          sendToTui({
            type: 'status',
            message: `Note: "${resolved}" is not in the known list — trying anyway.`,
          })
        }
        sessionOptions = { ...sessionOptions, model: resolved }
        await safeCloseSession(session)
        session = unstable_v2_createSession(sessionOptions)
        sessionId = null
        resetSessionCostTracking()
        sendBanner()
        sendToTui({
          type: 'status',
          message: `model -> ${resolved}${arg !== resolved ? ` (from "${arg}")` : ''}`,
        })
        return
      }
      case '/cwd':
        if (arg) {
          sessionOptions = { ...sessionOptions, cwd: arg } as SDKSessionOptions
          await safeCloseSession(session)
          session = unstable_v2_createSession(sessionOptions)
          sessionId = null
          resetSessionCostTracking()
          sendBanner()
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
        // Anything we don't handle is forwarded to the SDK as a normal user
        // input — cli.js's slash dispatcher will pick up /init, /agents,
        // /review, /skill-name etc. from the underlying Claude Code install.
        await runTurn(cmd)
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

/**
 * Route a tool_use to the right HostEvent type based on its name:
 *   - 'Skill'           → skill-call (skill name from input.skill)
 *   - 'mcp__a__b'       → mcp-call (server=a, tool=b)
 *   - everything else   → tool-use (built-in tools)
 */
function forwardToolUse(
  id: string,
  name: string,
  input: unknown,
  send: (ev: HostEvent) => void,
): void {
  if (name === 'Skill') {
    const skill = input && typeof input === 'object' && 'skill' in (input as Record<string, unknown>)
      ? String((input as Record<string, unknown>).skill ?? '')
      : ''
    send({ type: 'skill-call', id, skillName: skill || '(unknown)' })
    return
  }
  if (name.startsWith('mcp__')) {
    const [, server = '', tool = ''] = name.split('__')
    send({
      type: 'mcp-call',
      id,
      mcpServer: server,
      mcpTool: tool,
      input: summariseToolInput(tool, input),
    })
    return
  }
  send({
    type: 'tool-use',
    id,
    name,
    input: summariseToolInput(name, input),
  })
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function formatRelativeTs(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function extractContextWindow(r: SDKResultMessage): number | undefined {
  const usage = (r as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage
  if (!usage) return undefined
  for (const u of Object.values(usage)) {
    if (typeof u?.contextWindow === 'number' && u.contextWindow > 0) return u.contextWindow
  }
  return undefined
}

function resolveSelfRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, '../..')
}

function selfModSystemPrompt(base: string | undefined, root: string): string {
  const note =
    `You are running inside @miyago/claude-sdk, located at ${root}. ` +
    `Self-edit mode is enabled: you may read and modify files under that ` +
    `path to evolve the CLI/TUI/SDK adapter itself. After changes that ` +
    `affect the Go TUI (cmd/tui/), instruct the user to run ` +
    '`bash scripts/build-tui.sh` and restart `claude-sdk --tui`.'
  return base ? `${base}\n\n${note}` : note
}

function summariseToolInput(name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return ''
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'Bash':
      return typeof obj.command === 'string' ? obj.command.slice(0, 80) : ''
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof obj.file_path === 'string' ? obj.file_path : ''
    case 'Glob':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    case 'Grep':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    default: {
      const keys = Object.keys(obj).slice(0, 3)
      return keys.map((k) => `${k}=${truncate(String(obj[k]), 30)}`).join(' ')
    }
  }
}

function stringifyToolContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const obj = b as Record<string, unknown>
          if (typeof obj.text === 'string') return obj.text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>
    if (typeof obj.text === 'string') return obj.text
  }
  return JSON.stringify(content)
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function openDebugLog(): WriteStream | null {
  if (!process.env.CLAUDE_SDK_TUI_DEBUG) {
    const logPath = pjoin(tmpdir(), 'claude-sdk-tui.log')
    try {
      const s = createWriteStream(logPath, { flags: 'a' })
      s.write(`\n--- ${new Date().toISOString()} session start ---\n`)
      return s
    } catch {
      return null
    }
  }
  try {
    const s = createWriteStream(process.env.CLAUDE_SDK_TUI_DEBUG, { flags: 'a' })
    s.write(`\n--- ${new Date().toISOString()} session start ---\n`)
    return s
  } catch {
    return null
  }
}
