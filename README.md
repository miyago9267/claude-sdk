# @lovely-office/sdk

Forked `@anthropic-ai/claude-agent-sdk` **v0.2.77** with token optimization patches for Lovely Office.

Enables Claude Max subscription as a pollable AI backend — drop-in replacement for the official SDK,
usable via `query()` API for agent loops, tool use, and browser/embed transports.

## Patches applied (5 surgical patches to cli.js)

| # | Line | Description |
|---|------|-------------|
| 1 | ~236819 | Context overflow: safety margin 1000 → 200, emit `tengu_context_near_full_needs_compact` signal |
| 2 | ~346651 | Main fork loop: prune fork context to last 5 turns (reduces token waste in subagent chains) |
| 3 | ~391538 | Subagent fork: prune fork context messages to last 10 (reduces cold-start token cost) |
| 4 | ~455180 | Cache editing beta: enabled for `sdk` querySource, not just `repl_main_thread` |
| 5 | ~455529 | Streaming fallback: skip non-streaming retry if content blocks already received |

## Exports

```typescript
import { query, tool, createSdkMcpServer } from '@lovely-office/sdk';          // main
import cliPath from '@lovely-office/sdk/embed';                                 // Bun compiled binary embed
import { query as browserQuery } from '@lovely-office/sdk/browser';             // WebSocket transport (browser)
```

## Claude Max usage

Authenticate once with `claude login` (uses Max subscription OAuth), then drive via API:

```typescript
import { query } from '@lovely-office/sdk';

for await (const msg of query({ prompt: 'Hello', options: { model: 'claude-opus-4-6' } })) {
  if (msg.type === 'result') console.log(msg.result);
}
```

## Updating from official SDK

```bash
bash packages/sdk/scripts/patch.sh
```

The script beautifies the official cli.js, then patches are re-applied manually by the CLI agent.
