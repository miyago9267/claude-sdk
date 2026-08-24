import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type { RuntimeConfig } from './config/types.ts'

export interface ExecutionRequest {
  botId: string
  workspace: string
  sandboxed?: boolean
  runtimeConfig?: RuntimeConfig
}

export interface WorktreeLease {
  workspace: string
  release(): Promise<void>
}

export interface WorktreeAdapter {
  acquire(request: ExecutionRequest): Promise<WorktreeLease>
}

export interface ExecutionLease {
  workspace: string
  sandboxed: boolean
  release(): Promise<void>
}

export interface ExecutionBoundary {
  prepare(request: ExecutionRequest): Promise<ExecutionLease>
}

export interface WorkspaceExecutionBoundaryOptions {
  allowedRoots?: string[]
  requireSandbox?: boolean
  worktree?: WorktreeAdapter
}

export class WorkspaceExecutionBoundary implements ExecutionBoundary {
  private readonly allowedRoots: string[]

  constructor(private readonly options: WorkspaceExecutionBoundaryOptions = {}) {
    this.allowedRoots = options.allowedRoots?.map((root) => resolve(root)) ?? []
  }

  async prepare(request: ExecutionRequest): Promise<ExecutionLease> {
    const lease = this.options.worktree
      ? await this.options.worktree.acquire(request)
      : { workspace: request.workspace, release: async () => undefined }
    const workspace = await realpath(lease.workspace)
    const roots = await Promise.all(
      (this.allowedRoots.length > 0 ? this.allowedRoots : [workspace]).map((root) => realpath(root)),
    )
    if (!roots.some((root) => isWithin(root, workspace))) {
      await lease.release()
      throw new Error(`workspace is outside execution boundary: ${workspace}`)
    }
    if (this.options.requireSandbox && request.sandboxed !== true) {
      await lease.release()
      throw new Error(`sandbox is required for bot execution: ${request.botId}`)
    }
    return {
      workspace,
      sandboxed: request.sandboxed === true,
      release: lease.release,
    }
  }
}

function isWithin(root: string, target: string): boolean {
  const remainder = relative(root, target)
  return remainder === '' || (!remainder.startsWith('../') && !isAbsolute(remainder))
}
