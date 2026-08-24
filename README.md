# @miyago/claude-sdk

Subscription-backed wrapper around [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) (0.3.238), focused on building agent bots and protocol adapters:

- **Library** — re-exports the agent SDK plus a context-lifecycle manager.
- **API bridge** — an OpenAI-compatible (`/v1/chat/completions`) + Ollama-native (`/api/*`) HTTP server, so any harness (OpenAI SDK, LiteLLM, Aider, Continue, GitHub Copilot Chat…) can drive Claude on your Pro/Max subscription.

> **History:** versions ≤ 1.6.0 pinned agent-sdk 0.2.x and reverse-engineered a `sdk.mjs` patch to make the experimental `unstable_v2_createSession()` persistent session pass full options and hit the prompt cache. As of the 0.3.x migration that patch is **gone** — the persistent session is now the public `query()` streaming-input API, and SDK prompt caching is native. The current wrapper is pinned to agent-sdk 0.3.238; the old RE notes live in `docs/v2-spec/` and `docs/learning/` for the record.

## Why a persistent session

The classic `query()` one-shot spawns a fresh CLI process per call; runtime system-reminder injection varies across processes, so the prompt-cache prefix rarely matches (cache efficiency ~25%). Keeping one process alive across turns makes the prefix byte-identical, so it cache-reads instead of re-writing. Measured on the migrated 0.3.x adapter: **88% (turn 2) → 100% (turn 3)** efficiency.

## Install

```bash
bun add @miyago/claude-sdk
```

No postinstall, no patching — it consumes the official SDK as-is.

The repository checks npm for Agent SDK updates every Monday and opens a PR
only after the lockfile install, test suite, and Bun build pass. Run
`bun run update:agent-sdk` locally to perform the same update and verification.
At Claude Code session start, a project hook performs a read-only version check
and prints the update command when npm has a newer release.

## Quick Start

### Persistent session (streaming input)

The agent SDK's `query()` accepts an `AsyncIterable` of user messages and returns a `Query` you can feed over time — one live process, cache accumulates across turns.

```typescript
import { query, type SDKUserMessage } from '@miyago/claude-sdk'

async function* turns(): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: 'Hello!' }, parent_tool_use_id: null }
  // yield more messages later to continue the same cached session
}

const q = query({
  prompt: turns(),
  options: {
    model: 'claude-sonnet-4-6',
    cwd: process.cwd(),
    systemPrompt: 'You are a helpful assistant.',
    settingSources: ['project', 'local'], // load CLAUDE.md
    permissionMode: 'bypassPermissions',
  },
})

for await (const msg of q) {
  if (msg.type === 'assistant') console.log(msg.message?.content)
  if (msg.type === 'result') console.log('done:', msg.session_id)
}
```

The bridge wraps this pattern in an internal `createV2Session()` adapter (`send` / `stream` / `close`) backed by a history-keyed session pool; see `src/shared/query-session.ts`.

### Context Manager

Tracks context size, auto-compacts near limits, and keeps the cache alive with periodic pings.

```typescript
import { ContextManager, RECOMMENDED_SUBPROCESS_ENV } from '@miyago/claude-sdk/context'

const manager = new ContextManager(
  { watermarkTokens: 150_000, strategy: 'compact' },
  { enabled: true, cacheTTLMs: 3_600_000, marginMs: 900_000 }, // 1h TTL (Claude Max)
  {
    getSession: () => session,
    getSessionId: () => sessionId,
    restartSession: async (summary?) => { /* rebuild session */ },
    log: console.log,
    model: 'claude-sonnet-4-6',
    cwd: process.cwd(),
  },
)

manager.startKeepalive()
manager.updateFromResult(resultMessage)
await manager.checkWatermark() // auto-compacts if needed
manager.stopKeepalive()
```

`RECOMMENDED_SUBPROCESS_ENV` (pass into the session `env`) sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `CLAUDE_CODE_REMOTE=1` to keep the cache prefix stable.

## API bridge (OpenAI + Ollama)

Start the bridge from your own process. It speaks both the OpenAI Chat Completions wire format and the Ollama-native protocol:

```typescript
import { serveOllamaBridge } from '@miyago/claude-sdk/ollama'

serveOllamaBridge({ port: 11434, config: { defaultModel: 'claude-sonnet-4-6' } })
```

Point any OpenAI-compatible harness at it (the bridge ignores the API key and authenticates via your subscription OAuth):

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="dummy")
client.chat.completions.create(model="claude-sonnet-4-6", messages=[...])
```

Endpoints:

- OpenAI-compat: `GET /v1/models`, `POST /v1/chat/completions` (SSE streaming)
- Ollama-native: `GET /api/tags`, `POST /api/show`, `POST /api/chat`

Each chat call runs a full server-side agent turn in the bridge's cwd (built-in Read/Write/Bash/Edit/Glob/Grep), returning the final text. Sessions are pooled by client-history prefix hash so consecutive turns of the same conversation reuse a live, cache-warm process. A model the account can't access (e.g. `claude-fable-5`) returns the upstream error verbatim rather than a faked success.

### GitHub Copilot Chat

1. Start `serveOllamaBridge()` in your agent host process.
2. VS Code → Copilot Chat → **Manage Models** → **Ollama** → point at the URL.
3. Pick `claude-opus-4-8` / `claude-sonnet-4-6` / etc. Chat and Agent mode both route through the bridge.

See `docs/specs/ollama-bridge/SPEC.md` for ADRs.

## Exports

```typescript
// Main entry — re-exports @anthropic-ai/claude-agent-sdk (query, tool, types…)
import { query, tool } from '@miyago/claude-sdk'

// Context management
import { ContextManager, RECOMMENDED_SUBPROCESS_ENV, diffCumulativeModelUsage } from '@miyago/claude-sdk/context'

// Ollama / OpenAI bridge
import { serveOllamaBridge, createOllamaServer, buildTagsResponse } from '@miyago/claude-sdk/ollama'

// Shared conversation-history primitives
import { buildPromptFromHistory, extractAssistantBlocks, type HistoryMessage } from '@miyago/claude-sdk/shared'

```

## Notes

- `result.modelUsage` is a **cumulative session snapshot**, not a per-turn delta — use `diffCumulativeModelUsage()`.
- Cache TTL is 5 minutes (default) or 1 hour (Claude Max); `ContextManager.startKeepalive()` prevents expiry.
- Each persistent session holds one Node.js process (~100–200MB RAM).

## Research

Historical reverse-engineering of the Claude Code CLI (0.2.x era), kept for context:

- [Reverse Engineering Report](docs/leaarning/sdk-reverse-engineering-v76.md)
- [Anchor Index](docs/leaarning/sdk-anchor-index-v76.md)
- [V2 Persistent Session Notes](docs/v2-spec/v2-persistent-session-工程筆記.md)
- [System-Reminder Investigation](docs/leaarning/system-reminder-調查報告.md)

## License

MIT (original code only). The underlying `@anthropic-ai/claude-agent-sdk` is subject to [Anthropic's license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE).
