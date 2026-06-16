import type { V2Session } from '../shared/query-session.ts'

/**
 * Close a session defensively. close() may return a non-Promise value
 * (notably when the session was already torn down by an internal
 * slash-command handler), and a bare `session.close().catch(() => {})`
 * pattern crashed with `Cannot read properties of undefined (reading
 * 'catch')` in that case. Wrapping in try/catch around an
 * `await Promise.resolve(...)` accepts both shapes.
 */
export async function safeCloseSession(session: V2Session | null | undefined): Promise<void> {
  if (!session || typeof session.close !== 'function') return
  try {
    await Promise.resolve(session.close())
  } catch {
    // intentionally swallowed — close failures during teardown shouldn't
    // mask the real exit reason.
  }
}
