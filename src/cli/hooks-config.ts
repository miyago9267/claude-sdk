/**
 * Read hook configuration from settings.json. cli.js merges hooks across
 * project (<cwd>/.claude/settings.json), user (~/.claude/settings.json)
 * and plugin manifests; we cover the first two here for /hooks display.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface HookCommand {
  type?: string
  command: string
  shell?: string
  timeout?: number
  source: 'project' | 'user'
}

export interface HooksConfig {
  /** Map of hook event name → array of configured commands. */
  events: Record<string, HookCommand[]>
}

export interface DiscoverHooksOptions {
  cwd: string
  home?: string
}

export function discoverHooks(opts: DiscoverHooksOptions): HooksConfig {
  const home = opts.home ?? homedir()
  const result: HooksConfig = { events: {} }
  loadInto(result, join(opts.cwd, '.claude', 'settings.json'), 'project')
  loadInto(result, join(home, '.claude', 'settings.json'), 'user')
  return result
}

function loadInto(out: HooksConfig, path: string, source: 'project' | 'user'): void {
  if (!existsSync(path)) return
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }
  const hooks = (parsed as { hooks?: Record<string, unknown> })?.hooks
  if (!hooks || typeof hooks !== 'object') return
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue
    if (!out.events[event]) out.events[event] = []
    for (const entry of value) {
      // Two shapes appear in real configs:
      //   { type:"command", command:"...", ... }                ← simple
      //   { matcher: "...", hooks: [ {type, command, ...} ] }   ← grouped (cli.js)
      // We flatten both.
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>
        if (Array.isArray(obj.hooks)) {
          for (const h of obj.hooks as Record<string, unknown>[]) {
            pushCommand(out, event, h, source)
          }
        } else {
          pushCommand(out, event, obj, source)
        }
      }
    }
  }
}

function pushCommand(
  out: HooksConfig,
  event: string,
  obj: Record<string, unknown>,
  source: 'project' | 'user',
): void {
  const command = typeof obj.command === 'string' ? obj.command : ''
  if (!command) return
  out.events[event]!.push({
    type: typeof obj.type === 'string' ? obj.type : undefined,
    command,
    shell: typeof obj.shell === 'string' ? obj.shell : undefined,
    timeout: typeof obj.timeout === 'number' ? obj.timeout : undefined,
    source,
  })
}

export function formatHooks(cfg: HooksConfig): string {
  const events = Object.keys(cfg.events)
  if (events.length === 0) return 'No hooks configured.'
  events.sort()
  const lines = [`Configured hooks (${events.length} event${events.length === 1 ? '' : 's'}):`]
  for (const evt of events) {
    lines.push(`  ${evt}:`)
    for (const h of cfg.events[evt]!) {
      const tag = `[${h.source}]`
      const extras: string[] = []
      if (h.shell) extras.push(h.shell)
      if (h.timeout) extras.push(`timeout=${h.timeout}s`)
      const meta = extras.length ? ` (${extras.join(', ')})` : ''
      lines.push(`    ${tag} ${h.command}${meta}`)
    }
  }
  return lines.join('\n')
}
