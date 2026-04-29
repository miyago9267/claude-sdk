/**
 * Resolve the current git branch for a given cwd by reading .git/HEAD
 * directly. Cheaper than spawning `git`, handles worktrees/submodules where
 * .git is a pointer file, and walks up parent directories to find the repo
 * root. Returns null when not inside a git repo.
 */

import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function readGitBranch(cwd: string): string | null {
  let dir = cwd
  for (let i = 0; i < 64; i++) {
    const gitPath = join(dir, '.git')
    const branch = readBranchFromGitPath(gitPath)
    if (branch !== undefined) return branch

    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readBranchFromGitPath(gitPath: string): string | null | undefined {
  let stat
  try {
    stat = statSync(gitPath)
  } catch {
    return undefined
  }
  if (stat.isDirectory()) {
    return parseHead(join(gitPath, 'HEAD'))
  }
  if (stat.isFile()) {
    let pointer: string
    try {
      pointer = readFileSync(gitPath, 'utf8').trim()
    } catch {
      return null
    }
    const m = pointer.match(/^gitdir:\s*(.+)$/)
    if (!m) return null
    return parseHead(join(m[1]!, 'HEAD'))
  }
  return null
}

function parseHead(headPath: string): string | null {
  let content: string
  try {
    content = readFileSync(headPath, 'utf8').trim()
  } catch {
    return null
  }
  const ref = content.match(/^ref: refs\/heads\/(.+)$/)
  if (ref) return ref[1]!
  return content.slice(0, 7)
}

/**
 * Returns true if the working tree has any tracked or untracked changes.
 * One-shot `git status --porcelain` with a 2s timeout. Failure → false (we
 * don't want a slow git host to stall TUI startup).
 */
export function readGitDirty(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim().length > 0
  } catch {
    return false
  }
}
