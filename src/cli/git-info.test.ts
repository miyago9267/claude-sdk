import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readGitBranch } from './git-info.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cs-git-'))
}

describe('readGitBranch', () => {
  test('returns null outside any git repo', () => {
    const dir = tempDir()
    try {
      expect(readGitBranch(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('reads branch from real init+commit', () => {
    const dir = tempDir()
    try {
      execSync('git init -q -b main', { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'a')
      execSync('git -c user.email=a@b -c user.name=a add . && git -c user.email=a@b -c user.name=a commit -q -m x', { cwd: dir })
      expect(readGitBranch(dir)).toBe('main')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('walks up to parent dir when subdirectory is queried', () => {
    const dir = tempDir()
    try {
      execSync('git init -q -b feature/x', { cwd: dir })
      writeFileSync(join(dir, 'a.txt'), 'a')
      execSync('git -c user.email=a@b -c user.name=a add . && git -c user.email=a@b -c user.name=a commit -q -m x', { cwd: dir })
      const sub = join(dir, 'deep', 'nested')
      execSync(`mkdir -p ${sub}`, { cwd: dir })
      expect(readGitBranch(sub)).toBe('feature/x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
