# @lovely-office/sdk

Forked Claude Agent SDK with token optimization patches.

## Patches applied

1. Cache editing beta enabled for SDK mode
2. Subagent fork context pruned (max 5 turns)
3. Streaming fallback preserves partial content
4. Context overflow triggers input reduction

## Updating from official SDK

```bash
bash packages/sdk/scripts/patch.sh
```

## Usage

Drop-in replacement for `@anthropic-ai/claude-agent-sdk`:

```typescript
import { query } from '@lovely-office/sdk';
```
