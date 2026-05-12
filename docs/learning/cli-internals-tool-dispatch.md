# Tool Dispatcher — From `tool_use` to `tool_result`

> Reverse-engineered from `cli.js` v0.2.90. See
> [`cli-anchors.md`](./cli-anchors.md) for the string anchors used.

## TL;DR

1. A tool call's full lifetime: `tool_use` block in assistant message →
   permission gate (`canUseTool`) → executor → `tool_result` block in a
   user message → optional `tool_progress` heartbeats throughout.
2. Tool names fall into three families, distinguished by name prefix /
   literal:
   - **Built-in**: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
     `Agent`, `Task`, `Skill`, `NotebookEdit`, `WebSearch`, `WebFetch`,
     plus a handful more.
   - **MCP**: `mcp__<server>__<tool>` (e.g. `mcp__codex__exec`).
   - **Skill**: `Skill` (built-in dispatcher) whose `input.skill` names
     the actual skill.
3. `canUseTool` returns either `{behavior:"allow", updatedInput?}` or
   `{behavior:"deny", message, interrupt?}`. The result is enforced
   before any executor runs.
4. The result envelope `tool_result` lives **inside a user-role message**,
   not a separate event. That's why our jsonl-mirror walks user messages
   to find tool results.

---

## 1. Tool name parser

cli.js function `PT` (string anchor: `mcp__`):

```js
// Simplified — original is single-letter minified
function parseMcpToolName(q) {
  const K = q.split("__");
  const [prefix, server, ...rest] = K;
  if (prefix !== "mcp" || !server) return null;
  const tool = rest.length > 0 ? rest.join("__") : undefined;
  return { serverName: server, toolName: tool };
}
```

Reverse helper:

```js
function buildMcpToolName(server, tool) {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`;  // sanitize = y2()
}
```

> ⚠ The parser handles **tool names that contain `__`** (joins the rest
> with `__`). Our `forwardToolUse` in `src/cli/tui.ts` uses
> `name.split('__')` and grabs index 2 only — incorrect when an MCP
> exposes a tool literally named e.g. `do__thing`.

Built-in name constants (variables in cli.js):

```js
j4 = "Agent"       // generic sub-agent invocation
NI = "Task"        // structured task dispatcher (subagent + status)
```

Skill literal: `"Skill"` (anchor confirmed at offset 8735071+; tool
dispatcher reads `tool_use.input.skill` to pick which SKILL.md to load).

## 2. Permission gate

The SDK's `canUseTool` callback (in `SDKSessionOptions`) wires into
this gate. Signature:

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal, suggestions?, blockedPath?, decisionReason? }
) => Promise<PermissionResult>

type PermissionResult =
  | { behavior: "allow"; updatedInput?; updatedPermissions?; toolUseID?; decisionClassification? }
  | { behavior: "deny";  message: string; interrupt?; toolUseID?; decisionClassification? }
```

cli.js wraps this with the active permission mode:

```
permissionMode = "bypassPermissions"  → canUseTool is short-circuited to allow
                = "default"            → canUseTool is called for "dangerous" tools
                                          (Write, Edit, Bash, etc); read-only auto-allowed
                = "acceptEdits"        → Edit/Write auto-allowed; everything else like default
                = "plan"               → canUseTool can return deny to keep planning
                = "dontAsk"            → canUseTool not called; pre-approved allowlist only
```

Our `canUseToolCallback` in `src/cli/tui.ts` returns `{behavior:"allow"}` or
`{behavior:"deny", message}`. We don't currently use `updatedInput` or
`updatedPermissions` — both are the path to "allow-always for this session".

## 3. Lifecycle

```
[ assistant message arrives ]
    └─ contains content[] with one or more { type:"tool_use", id, name, input }
        │
        ▼
[ for each tool_use: ]
    1. cli.js classifies: built-in | mcp | skill
    2. cli.js runs PreToolUse hooks (see hook-engine.md)
    3. cli.js calls canUseTool(name, input, opts)
         ├─ behavior:"deny"  → emit tool_result {is_error:true, content:message}
         │                     → record permission_denials[]
         │                     → emit (eventually) result.subtype:"permission_denials"
         └─ behavior:"allow" → continue, optional updatedInput overrides args
    4. cli.js spawns the executor:
         - Built-in: in-process (Bash spawns shell, Read reads fs, etc)
         - MCP: forward via stdio to the MCP server, await response
         - Skill: load <SKILL.md>, inject markdownContent into system
                  prompt, continue main loop (no separate result)
    5. while executor runs: emit tool_progress { elapsed_time_seconds }
       (no fixed cadence; sent on cli.js's internal timer)
    6. executor produces output, cli.js builds a user message with
       content[].push({ type:"tool_result", tool_use_id, content,
                        is_error? })
    7. PostToolUse hooks fire
    8. message goes back into the conversation
```

Key consequences for our implementation:

- We **don't** see the executor itself — only `tool_use` (input) and the
  matching `tool_result` (output). That's why our `toolByID` map keys on
  `tool_use_id` and binds the two together on render.
- `tool_progress` is purely informational; we use it as a heartbeat to
  refresh the elapsed timer (our local 1s tick is the actual clock).
- A `tool_result` with `is_error:true` doesn't mean the *tool ran* — it
  could mean canUseTool denied it. We can't distinguish "executed but
  failed" from "blocked before executing" without checking
  `permission_denials[]` on the final result message.

## 4. Result message envelope

In jsonl (and in SDK stream):

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "tool_result",
        "tool_use_id": "tu_abc123",
        "content": [{ "type": "text", "text": "exit=0\n…" }],
        "is_error": false }
    ]
  },
  …
}
```

> The `content` of a `tool_result` can be:
> - a string (rare)
> - `[{type:"text", text:"..."}, ...]` (most common)
> - `[{type:"image", source:{...}}, ...]` (Read on an image, screenshots)
> - mixed array

Our `stringifyToolContent` in `src/cli/tui.ts` handles string + array of
text; image / mixed is silently dropped. **Bug**: a screenshot tool_result
shows up as an empty `⎿` line in the TUI.

## 5. Three families of tool — how we tell them apart

| Family | Wire `tool_use.name` | Routing in our forwarder |
|---|---|---|
| Built-in | `Bash`, `Read`, …, `Task`, `Agent`, `Skill` | `forwardToolUse` default → `tool-use` event |
| MCP | starts with `mcp__` | `mcp-call` event with `{server, tool}` |
| Skill | literal `Skill` | `skill-call` event with `{skillName}` |

But:

- Cli.js doesn't have a "category" field — the *only* signal is the
  name. So our router has to keep matching strings forever (the
  classification is unstable).
- `Agent` and `Task` look like normal built-ins but they spawn
  **another LLM conversation** (`SubagentStart` hook fires). We currently
  render them as plain tool calls; should they get their own visual
  treatment, like the `▸ task` row from `SDKTaskStartedMessage`?
- A skill's body becomes additional system-prompt content for the next
  turn — there is **no separate tool_result**. The `Skill` `tool_use`
  finishes and the model continues. Our TUI shows the skill row but
  never gets a matching ✓/✗ — it stays `⏺` forever.

## 6. Action items for claude-sdk

| Action | Effort | Priority |
|---|---|---|
| Fix `mcp__` name parser to handle tool names with `__` inside | trivial | HIGH |
| Distinguish "executed but failed" vs "permission denied" by looking at result message's `permission_denials[]` | small | MED |
| Render image tool_result blocks (at least with `[image: <kind>]`) | small | MED |
| Mark `Agent` / `Task` tools with the task visual treatment | small | MED |
| Resolve the dangling `Skill` `⏺` — flip to ✓ on `assistant-end` | trivial | HIGH |
| Surface `permission_denials[]` from the final result message in the TUI | small | LOW |

## 7. Open questions

- What exactly fires `tool_progress`? Internal timer? Per-stdout-line?
  Need to instrument and watch.
- Where is the executor registry? We didn't trace which symbol holds
  the `{Bash: handler, Read: handler, …}` map. (Useful for understanding
  what built-in names exist.)
- Is there a stable list of tool names we can pull from cli.js to keep
  our `forwardToolUse` switch in sync? Or do we lean on the SDK type?
- For MCP tools, are there per-server timeouts we can read?

## 8. References

- cli.js v0.2.90 (anchors: `mcp__`, `PT`, `j4`, `NI`, `tool_use`,
  `tool_progress`, `permission_denials`)
- sdk.d.ts: `CanUseTool`, `PermissionResult`, `SDKToolProgressMessage`,
  `SDKPermissionDenial`
- Our impl: `forwardToolUse` and `canUseToolCallback` in
  `src/cli/tui.ts`, `renderToolUse`/`renderMcpCall`/`renderSkillCall` in
  `cmd/tui/main.go`
