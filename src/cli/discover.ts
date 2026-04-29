/**
 * Discover slash commands and skills installed at the official Claude Code
 * locations. We mirror the same lookup paths the official CLI uses so
 * `claude-sdk --tui` shows the same set the user already has.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SlashCommand {
  name: string
  source: 'project' | 'user' | 'plugin'
  path: string
  description?: string
}

export interface SkillEntry {
  name: string
  source: 'project' | 'user' | 'plugin'
  path: string
  description?: string
}

export interface DiscoverOptions {
  cwd: string
  /** Override $HOME — useful for tests. Default: os.homedir(). */
  home?: string
}

export function discoverCommands(opts: DiscoverOptions): SlashCommand[] {
  const home = opts.home ?? homedir()
  const out: SlashCommand[] = []
  scanCommandsDir(join(opts.cwd, '.claude', 'commands'), 'project', out)
  scanCommandsDir(join(home, '.claude', 'commands'), 'user', out)
  scanPluginsCommandDirs(join(home, '.claude', 'plugins'), out)
  return dedupeByName(out)
}

export function discoverSkills(opts: DiscoverOptions): SkillEntry[] {
  const home = opts.home ?? homedir()
  const out: SkillEntry[] = []
  scanSkillsDir(join(opts.cwd, '.claude', 'skills'), 'project', out)
  scanSkillsDir(join(home, '.claude', 'skills'), 'user', out)
  scanPluginsSkillDirs(join(home, '.claude', 'plugins'), out)
  return dedupeByName(out)
}

function scanCommandsDir(dir: string, source: SlashCommand['source'], out: SlashCommand[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const path = join(dir, name)
    out.push({
      name: '/' + name.replace(/\.md$/, ''),
      source,
      path,
      description: readFrontmatterDescription(path),
    })
  }
}

function scanSkillsDir(dir: string, source: SkillEntry['source'], out: SkillEntry[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const skillFile = join(dir, name, 'SKILL.md')
    try {
      if (!statSync(skillFile).isFile()) continue
    } catch {
      continue
    }
    out.push({
      name,
      source,
      path: skillFile,
      description: readFrontmatterDescription(skillFile),
    })
  }
}

function scanPluginsCommandDirs(pluginsRoot: string, out: SlashCommand[]): void {
  let plugins: string[]
  try {
    plugins = readdirSync(pluginsRoot)
  } catch {
    return
  }
  for (const plugin of plugins) {
    scanCommandsDir(join(pluginsRoot, plugin, 'commands'), 'plugin', out)
  }
}

function scanPluginsSkillDirs(pluginsRoot: string, out: SkillEntry[]): void {
  let plugins: string[]
  try {
    plugins = readdirSync(pluginsRoot)
  } catch {
    return
  }
  for (const plugin of plugins) {
    scanSkillsDir(join(pluginsRoot, plugin, 'skills'), 'plugin', out)
  }
}

function readFrontmatterDescription(path: string): string | undefined {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  if (!content.startsWith('---')) return undefined
  const end = content.indexOf('\n---', 3)
  if (end < 0) return undefined
  const block = content.slice(3, end)
  const m = block.match(/^description:\s*(.+)$/m)
  if (!m) return undefined
  return m[1]!.trim().replace(/^['"]|['"]$/g, '')
}

function dedupeByName<T extends { name: string }>(arr: T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of arr) {
    if (seen.has(item.name)) continue
    seen.add(item.name)
    out.push(item)
  }
  return out
}

/** Format a list as a multi-line plain-text status block. */
export function formatList(
  title: string,
  items: Array<{ name: string; source: string; description?: string }>,
): string {
  if (items.length === 0) return `${title}: (none found)`
  const lines = [`${title} (${items.length}):`]
  for (const it of items) {
    const desc = it.description ? `  ${truncate(it.description, 70)}` : ''
    lines.push(`  ${it.name}  [${it.source}]${desc}`)
  }
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
