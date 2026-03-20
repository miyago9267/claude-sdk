# @miyago/claude-sdk

Drop-in wrapper for [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) that patches V2 persistent session support and adds context lifecycle management.

**Problem:** The official SDK's V1 `query()` spawns a new CLI process per call. Runtime system-reminder injection varies across processes, breaking prompt cache prefix match. Cache efficiency stays at ~25%.

**Solution:** Patch the V2 `unstable_v2_createSession()` API to accept full options (settingSources, cwd, systemPrompt, mcpServers, etc.), keep the CLI process alive across messages, and let cache accumulate naturally. Measured efficiency: **82-100%** (avg 91%).

## Install

```bash
bun add @miyago/claude-sdk
```

The `postinstall` script automatically patches `sdk.mjs` in `node_modules`.
For the 5 optional `cli.js` patches (requires beautify), run manually:

```bash
bash scripts/patch.sh
```

## Quick Start

### V2 Persistent Session (recommended)

```typescript
import { unstable_v2_createSession } from '@miyago/claude-sdk'

const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-6',
  cwd: process.cwd(),
  systemPrompt: 'You are a helpful assistant.',
  settingSources: ['project', 'local'],  // load CLAUDE.md
  maxTurns: 10,
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
})

// Send messages — same CLI process, cache accumulates
await session.send('Hello!')
for await (const msg of session.stream()) {
  if (msg.type === 'assistant') {
    console.log(msg.message?.content)
  }
  if (msg.type === 'result') {
    console.log('Done:', msg.session_id)
  }
}

// Send another message — cache hit
await session.send('Follow up question')
for await (const msg of session.stream()) {
  // ...
}

// Clean up
session.close()
```

### V1 Query (fallback)

```typescript
import { query } from '@miyago/claude-sdk'

const q = query({
  prompt: 'Hello!',
  options: {
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
    cwd: process.cwd(),
  },
})

for await (const msg of q) {
  if (msg.type === 'result') {
    console.log('Session:', msg.session_id)
  }
}
```

### Context Manager

Tracks context size, auto-compacts when approaching limits, and keeps cache alive with periodic pings.

```typescript
import { ContextManager, RECOMMENDED_SUBPROCESS_ENV } from '@miyago/claude-sdk/context'

const manager = new ContextManager(
  {
    watermarkTokens: 150_000,  // trigger at 150K tokens
    strategy: 'compact',       // 'handoff' | 'compact' | 'restart'
  },
  {
    enabled: true,
    cacheTTLMs: 3_600_000,     // 1 hour (Claude Max)
    marginMs: 900_000,         // ping 15min before expiry
  },
  {
    getSession: () => session,
    getSessionId: () => sessionId,
    restartSession: async (summary?) => { /* rebuild session */ },
    log: console.log,
    model: 'claude-sonnet-4-6',
    cwd: process.cwd(),
  },
)

// Start cache keepalive timer
manager.startKeepalive()

// After each interaction
manager.updateFromResult(resultMessage)
await manager.checkWatermark()  // auto-compacts if needed

// Cleanup
manager.stopKeepalive()
```

### Subprocess Environment

Use `RECOMMENDED_SUBPROCESS_ENV` when spawning V2 sessions to optimize token usage:

```typescript
import { RECOMMENDED_SUBPROCESS_ENV } from '@miyago/claude-sdk/context'

const session = unstable_v2_createSession({
  // ...
  env: { ...process.env, ...RECOMMENDED_SUBPROCESS_ENV },
})
```

This sets:
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=5` -- aggressive auto-compact
- `CLAUDE_CODE_REMOTE=1` -- skip gitStatus injection (eliminates a cache bust source)

## What Gets Patched

### sdk.mjs (5 patches, auto-applied on install)

The official V2 `unstable_v2_createSession()` hardcodes many options. These patches unlock them:

| # | Option | Before | After |
|---|--------|--------|-------|
| 1 | `settingSources` | `[]` | `opts.settingSources ?? []` |
| 2 | `cwd` | `process.cwd()` | `opts.cwd` |
| 3 | `thinkingConfig`, `maxTurns`, `maxBudgetUsd` | `void 0` | from opts |
| 4 | `mcpServers` | `{}` | from opts (CLI-side filtered) |
| 5 | `systemPrompt`, SDK MCP routing | `new Map`, no initConfig | from opts |

### cli.js (5 patches, manual after beautify)

| # | What | Why |
|---|------|-----|
| 1 | Context overflow margin 1000 -> 200 | Maximize usable context window |
| 2 | Fork pruning: keep last 5 turns | Prevent exponential context growth in agent chains |
| 3 | Subagent pruning: keep last 10 messages | Reduce subagent cold start cost |
| 4 | Enable prompt cache for SDK querySource | **Biggest impact** -- official only enables for REPL |
| 5 | Skip non-streaming retry if content received | Avoid 2x token waste on stream failure |

## How Cache Efficiency Works

```
V1 query() -- new process each call
  system prompt (15K) -> cache READ
  messages (45K)      -> cache WRITE (content differs each spawn)
  efficiency: ~25%

V2 createSession() -- persistent process
  system prompt (15K) -> cache READ
  messages (45K)      -> cache READ (same process = stable content)
  only new content    -> cache WRITE
  efficiency: 82-100%
```

The root cause is runtime system-reminder injection (gitStatus, readFileState diffs, memory mtimes). When the CLI process stays alive, these injections remain byte-for-byte identical, so the cache prefix matches.

## Upgrading the Official SDK

When `@anthropic-ai/claude-agent-sdk` releases a new version:

```bash
# 1. Update version
bun add @anthropic-ai/claude-agent-sdk@latest

# 2. Check if sdk.mjs patches still apply
bash scripts/patch-v2.sh --check

# 3. If patches fail, use anchor strings to relocate
#    See docs/leaarning/sdk-anchor-index-v76.md

# 4. For cli.js patches, beautify first
bash scripts/patch.sh

# 5. Run tests
bun test
```

Key anchor strings for relocating minified functions:

| Function | Anchor String |
|----------|--------------|
| SDKSession class | `"Cannot send to closed session"` |
| ProcessTransport | `"--output-format"` |
| Query class | `"pendingControlResponses"` |
| Cache control | `"prompt-caching-scope-2026-01-05"` |

Full anchor index: [`docs/leaarning/sdk-anchor-index-v76.md`](docs/leaarning/sdk-anchor-index-v76.md)

## Exports

```typescript
// Main entry -- re-exports everything from @anthropic-ai/claude-agent-sdk
import { query, unstable_v2_createSession, tool } from '@miyago/claude-sdk'

// Context management
import {
  ContextManager,
  RECOMMENDED_SUBPROCESS_ENV,
  diffCumulativeModelUsage,
} from '@miyago/claude-sdk/context'
```

## Important Notes

- `result.modelUsage` is a **cumulative session snapshot**, not a per-turn delta. Use `diffCumulativeModelUsage()` to compute deltas.
- V2 API is `unstable_*` -- may change in future SDK versions. Design with V1 fallback.
- Cache TTL is 5 minutes (default) or 1 hour (Claude Max). Use `ContextManager.startKeepalive()` to prevent expiry.
- Each V2 session holds one Node.js process (~100-200MB RAM).

## Research

This package is built on reverse engineering of the Claude Code CLI binary. Full documentation:

- [Reverse Engineering Report](docs/leaarning/sdk-reverse-engineering-v76.md) -- end-to-end flow analysis (Stages A-F)
- [Anchor Index](docs/leaarning/sdk-anchor-index-v76.md) -- minified symbol mapping for version upgrades
- [V2 Patch Engineering Notes](docs/v2-spec/v2-persistent-session-工程筆記.md) -- patch design and idempotency
- [System-Reminder Investigation](docs/leaarning/system-reminder-調查報告.md) -- all 30+ injection types documented

## License

MIT (original code only). The underlying `@anthropic-ai/claude-agent-sdk` is subject to [Anthropic's license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE).
