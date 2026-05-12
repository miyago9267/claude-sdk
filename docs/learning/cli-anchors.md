# cli.js Anchor Index (v0.2.90)

> Strings & symbol patterns that reliably locate features inside the 12.5MB
> minified `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`. Use these
> for future grep — minified variable names rotate per build, **strings
> survive**.

## Hook engine

| Anchor | Meaning |
|---|---|
| `"PreToolUse"` | First member of the 27-event hook list (variable `UR`) |
| `"PostToolUse"` | + others — see full list below |
| `"hook_started"` | Schema for `SDKHookStartedMessage` (zod) |
| `"hook_progress"` | Schema for `SDKHookProgressMessage` (incremental stdout/stderr) |
| `"hook_response"` | Schema for `SDKHookResponseMessage` (terminal, has `exit_code` + `outcome`) |
| `"command"` + zod `Tb5` | Hook command shape (type/command/if/shell/timeout) |
| `mC7 = ["bash","powershell"]` | Supported hook shells |

Full hook event list (`UR` in v0.2.90, 27 items):

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
PreCompact, PostCompact, PermissionRequest, PermissionDenied, Setup,
TeammateIdle, TaskCreated, TaskCompleted, Elicitation, ElicitationResult,
ConfigChange, WorktreeCreate, WorktreeRemove, InstructionsLoaded,
CwdChanged, FileChanged
```

> SDK's public `HookEvent` type only exports the first 9. The other 18 are
> internal-only or surfaced via different schemas (TaskNotification,
> ElicitationComplete, ConfigChange ↔ banner refresh, etc).

## Tool dispatcher

| Anchor | Meaning |
|---|---|
| `"tool_use"` | Tool-call block type literal |
| `"tool_use_id"` / `"toolUseId"` | Two casings — wire format vs internal |
| `"tool_progress"` | Schema for elapsed-time heartbeat |
| `"permission_denials"` | Result-level array of denied tool calls |
| `mcp__` prefix | MCP tool name pattern `mcp__<server>__<tool>` |
| `PT(name)` function | Parser for the above (returns `{serverName, toolName}` or null) |
| `j4 = "Agent"`, `NI = "Task"` | Built-in sub-agent dispatcher tool names |
| `canUseTool` | Permission gate callback hook |
| `behavior:"allow"` / `behavior:"deny"` | Return shape from canUseTool |

## Skill invocation

| Anchor | Meaning |
|---|---|
| `"SKILL.md"` | The required filename in each `<dir>/<skill>/SKILL.md` |
| `"skill_listing"` | Event when skill registry finishes loading |
| `"Skill"` | Built-in tool name (used as `tool_use.name`) |
| `Gt1` function | Skill metadata builder (frontmatter parser) |
| `vt1` function | Skill object factory (`{skillName, markdownContent, source, baseDir, loadedFrom}`) |

Recognised skill frontmatter keys:

```yaml
name: my-skill
description: # used as trigger hint for the model
user-invocable: true | false   # default true; if false, model invokes only
model: inherit | <model-id>     # optional, per-skill model override
effort: low | medium | high | max | <int>  # optional thinking budget
```

## How to add new anchors

When reverse engineering a new feature:

1. Find a `h.literal("…")` / `subtype:"…"` zod schema near the feature.
2. Grep that literal, take ±400 bytes context with `dd`.
3. Note the obfuscated variable name once (changes per build) and the
   schema fields.
4. Append a row here.

Symbol names like `UR`, `Tb5`, `Gt1`, `PT`, `j4`, `NI`, `wUz`, `jUz` are
**v0.2.90-specific** — re-grep with the string anchor after every SDK
upgrade.

## Automated verification

After every `bun add @anthropic-ai/claude-agent-sdk@latest`, run:

```bash
bash scripts/verify-anchors.sh
```

The script greps cli.js for every documented anchor, prints hit counts,
and exits non-zero if any anchor went missing — in that case the
feature probably moved or the literal changed, and the corresponding
`docs/learning/cli-internals-*.md` doc needs a re-rev.
