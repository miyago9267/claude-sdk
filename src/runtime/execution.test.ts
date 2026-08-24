import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { WorkspaceExecutionBoundary } from './execution.ts'

describe('WorkspaceExecutionBoundary', () => {
  test('accepts an allowed workspace and returns a sandbox lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-sdk-boundary-'))
    const workspace = join(root, 'bot')
    await mkdir(workspace)
    try {
      const lease = await new WorkspaceExecutionBoundary({ allowedRoots: [root], requireSandbox: true }).prepare({
        botId: 'bot-1',
        workspace,
        sandboxed: true,
      })
      expect(lease.workspace).toBe(await realpath(workspace))
      expect(lease.sandboxed).toBe(true)
      await lease.release()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects a workspace outside the allowed roots and releases a worktree lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-sdk-boundary-'))
    const outside = await mkdtemp(join(tmpdir(), 'claude-sdk-outside-'))
    let released = false
    try {
      await expect(new WorkspaceExecutionBoundary({ allowedRoots: [root], worktree: {
        acquire: async () => ({ workspace: outside, release: async () => { released = true } }),
      } }).prepare({ botId: 'bot-1', workspace: root })).rejects.toThrow('outside execution boundary')
      expect(released).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
