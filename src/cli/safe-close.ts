import type { SDKSession } from '@anthropic-ai/claude-agent-sdk'

/**
 * Close an SDKSession defensively. The patched SDK occasionally returns a
 * non-Promise value from close() (notably when the session was already torn
 * down by an internal slash-command handler), and the previous
 * `session.close().catch(() => {})` pattern crashed with `Cannot read
 * properties of undefined (reading 'catch')` in that case. Wrapping in
 * try/catch around an `await Promise.resolve(...)` accepts both shapes.
 */
export async function safeCloseSession(session: SDKSession | null | undefined): Promise<void> {
  if (!session || typeof session.close !== 'function') return
  try {
    await Promise.resolve(session.close())
  } catch {
    // intentionally swallowed — close failures during teardown shouldn't
    // mask the real exit reason.
  }
}
