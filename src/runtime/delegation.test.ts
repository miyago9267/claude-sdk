import { describe, expect, test } from 'bun:test'

import { DelegationManager } from './delegation.ts'
import { RuntimeEventBus } from './events.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('DelegationManager', () => {
  test('routes child completion to the parent and preserves the child run handle', async () => {
    const events = new RuntimeEventBus()
    const seen: string[] = []
    events.subscribe((event) => seen.push(event.type))
    const child = deferred<{ runId: string; status: 'completed'; output: string }>()
    let cancelled = false
    const runtime = {
      start: () => ({
        runId: 'child-1',
        result: child.promise,
        cancel: () => { cancelled = true; return true },
      }),
    }
    const manager = new DelegationManager({ runtime: runtime as never, events })

    const handle = manager.start({
      taskId: 'research',
      parentRunId: 'parent-1',
      botId: 'worker',
      sessionKey: 'parent-1:child:research',
      trigger: 'job',
      prompt: 'research this',
    })
    expect(handle.childRunId).toBe('child-1')
    child.resolve({ runId: 'child-1', status: 'completed', output: 'done' })

    await expect(handle.result).resolves.toMatchObject({ status: 'completed', output: 'done' })
    expect(cancelled).toBe(false)
    expect(seen).toEqual(['delegation.requested', 'delegation.started', 'delegation.completed'])
  })

  test('cancels timed-out children and aggregates partial failures', async () => {
    const pending = deferred<{ runId: string; status: 'completed'; output: string }>()
    let cancelSlow!: () => void
    const runtime = {
      start: (request: { taskId?: string }) => {
        if (request.taskId === 'slow') {
          cancelSlow = () => pending.resolve({ runId: 'child-slow', status: 'completed', output: 'late' })
          return {
            runId: 'child-slow',
            result: pending.promise.then((result) => ({ ...result, status: 'cancelled' as const })),
            cancel: () => { cancelSlow(); return true },
          }
        }
        return {
          runId: 'child-failed',
          result: Promise.resolve({ runId: 'child-failed', status: 'failed' as const, error: 'failed' }),
          cancel: () => true,
        }
      },
    }
    const manager = new DelegationManager({ runtime: runtime as never })

    const aggregatePromise = manager.delegateMany('parent-2', [
      {
        taskId: 'slow',
        parentRunId: 'parent-2',
        botId: 'worker',
        sessionKey: 'child-slow',
        trigger: 'job',
        prompt: 'slow task',
        timeoutMs: 5,
      },
      {
        taskId: 'failed',
        parentRunId: 'parent-2',
        botId: 'worker',
        sessionKey: 'child-failed',
        trigger: 'job',
        prompt: 'failed task',
      },
    ])
    const aggregate = await aggregatePromise

    expect(aggregate.results).toHaveLength(2)
    expect(aggregate.completed).toBe(0)
    expect(aggregate.failed).toBe(2)
    expect(aggregate.partialFailure).toBe(false)
  })
})
