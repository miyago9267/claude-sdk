# Hook Engine — How cli.js Runs `~/.claude/hooks/*.sh`

> Reverse-engineered from `cli.js` v0.2.90 (12.5MB minified). See
> [`cli-anchors.md`](./cli-anchors.md) for the symbol/string anchors used to
> locate the code below.

## TL;DR

1. cli.js holds 27 hook events (only 9 are public SDK types).
2. Each hook config = `{type:"command", command, if?, shell?, timeout?}`.
3. Triggering a hook spawns a shell, streams stdout/stderr back as 3
   `system` messages: `hook_started` → `hook_progress…` → `hook_response`.
4. `hook_response.outcome ∈ {"success","error","cancelled"}` is the
   authoritative success signal — exit_code alone isn't.
5. We currently only surface `hook_started` + `hook_response` in TUI;
   `hook_progress` and the `outcome`/`exit_code` fields are dropped.

---

## 1. Hook config schema

Zod schema in cli.js (function `Tb5`):

```js
z.object({
  type: z.literal("command"),                   // only shape v0.2.90 supports
  command: z.string(),                          // shell command to run
  if: <conditional schema>,                     // gating predicate
  shell: z.enum(["bash","powershell"]).optional(), // default: $SHELL
  timeout: z.number().positive().optional(),    // seconds, hard kill
})
```

Source of truth lives in user `settings.json` or plugin manifest:

```json
{
  "hooks": {
    "PreToolUse": [
      { "type": "command", "command": "~/.claude/hooks/auto-yes.sh", "timeout": 5 }
    ],
    "PostToolUse": [
      { "type": "command", "command": "~/.claude/hooks/markdown-lint-fix.sh" }
    ]
  }
}
```

Multiple hooks per event run **sequentially** (observed) — the array
order is the dispatch order.

## 2. The 27-event list

cli.js variable `UR` holds the full list:

```
PreToolUse              PostToolUse           PostToolUseFailure
Notification            UserPromptSubmit       SessionStart
SessionEnd              Stop                   StopFailure
SubagentStart           SubagentStop           PreCompact
PostCompact             PermissionRequest      PermissionDenied
Setup                   TeammateIdle           TaskCreated
TaskCompleted           Elicitation            ElicitationResult
ConfigChange            WorktreeCreate         WorktreeRemove
InstructionsLoaded      CwdChanged             FileChanged
```

SDK's public `HookEvent` only exports the first 9 plus
`PreCompact` + `Notification`. The other 18 are internal — some surface
via separate schemas (`TaskNotification` for the Task family,
`ElicitationComplete` for MCP elicitation, etc).

## 3. Message lifecycle on a hook fire

For every command that gets a hook firing (e.g. a Bash tool execution
with a `PreToolUse` rule attached):

```
┌────────────────────────────────────────────────────────────────┐
│ 1. cli.js decides 'PreToolUse fires for Bash'                  │
│ 2. emit  hook_started   { hook_id, hook_name, hook_event }     │
│ 3. spawn child (bash $command)                                 │
│ 4. tee stdout/stderr in chunks:                                │
│      emit  hook_progress { stdout, stderr, output }  *N times  │
│ 5. child exits with exit_code                                  │
│ 6. emit  hook_response  { exit_code, outcome, stdout, stderr } │
│      outcome = success | error | cancelled                     │
│ 7. cli.js decides to allow / deny / modify the tool call based │
│    on outcome + stdout JSON ({"decision":"allow"|"deny"|...}) │
└────────────────────────────────────────────────────────────────┘
```

The three messages share a `hook_id` UUID so a renderer can group them.
We currently treat each event independently.

## 4. Zod schemas (verbatim, minified vars only)

```js
// hook_started — variable AUz
{ type: "system", subtype: "hook_started",
  hook_id: string, hook_name: string, hook_event: string,
  uuid, session_id }

// hook_progress — variable wUz
{ type: "system", subtype: "hook_progress",
  hook_id, hook_name, hook_event,
  stdout: string, stderr: string, output: string,
  uuid, session_id }

// hook_response — variable jUz
{ type: "system", subtype: "hook_response",
  hook_id, hook_name, hook_event,
  output: string, stdout: string, stderr: string,
  exit_code?: number,
  outcome: "success" | "error" | "cancelled",
  uuid, session_id }
```

## 5. Where we currently consume each message

`src/cli/tui.ts` → forwarder:

```ts
if (sub === 'hook_started') {
  sendToTui({ type: 'hook', hookEvent, hookName, hookStatus: 'started' })
} else if (sub === 'hook_response') {
  const ok = !m2.stderr || m2.stderr.trim().length === 0   // ⚠ wrong proxy
  sendToTui({ type: 'hook', hookEvent, hookName,
              hookStatus: ok ? 'ok' : 'err',
              durationMs: m2.duration_ms ?? 0 })
}
// hook_progress: not handled
```

Issues found by this reverse:

1. **Success proxy is wrong** — we infer success from "no stderr", but
   cli.js exposes `outcome: 'success'|'error'|'cancelled'` directly.
   Should switch to that.
2. **`exit_code` is dropped** — non-zero exit code with stderr can still
   be a "soft fail" we want to flag distinctly from a panic.
3. **`hook_progress` is ignored** — streaming stdout from long-running
   hooks (e.g. a lint pass on a big file) currently shows as nothing
   between started/response. Could render a dim `⟳ <last line of stdout>`
   under the hook line.
4. **There's no `duration_ms` field** in the actual schema — we set 0.
   Cli.js doesn't compute it. We need to compute locally between
   started→response.
5. **PostToolUseFailure / PostCompact / etc** also surface as
   system events but with different shapes — they're 18 of the 27 we
   never touched. Most are low-value to render; the high-value ones are
   probably `TaskCreated/TaskCompleted` (we got those via the Task
   schema separately) and `Elicitation` (Phase D.7 open item).

## 6. Action items for claude-sdk

| Action | Effort | Priority |
|---|---|---|
| Switch hook ok/err proxy to `outcome` field | trivial | HIGH |
| Compute `durationMs` from started→response timestamps | trivial | HIGH |
| Surface `exit_code` in TUI line when non-zero | trivial | MED |
| Render `hook_progress` (dim, single-line tail) under started line | small | MED |
| Surface `Elicitation` event when V2 SDK starts emitting it | dep on SDK | LOW |
| Add a `/hooks` slash command listing configured hooks per event | small | MED |

## 7. Open questions

- The `if` field in hook config is a "gating predicate" — what schema?
  Looks like another zod block (`LA8`) we didn't trace.
- `hook_progress.output` vs `stdout` — what's the difference? (Possibly
  output = combined stdout+stderr in arrival order, vs separated.)
- Are there hook *user prompts* or only auto-fire?
- Hook config can come from settings.json **OR** plugin manifest — we
  haven't traced the merge order.

## 8. References

- cli.js v0.2.90 (anchors: `"PreToolUse"`, `"hook_started"`,
  `"hook_response"`, `"hook_progress"`, `Tb5` config schema)
- sdk.d.ts: `HookEvent`, `SDKHook*Message`
- Our impl: `src/cli/tui.ts` (forwarder), `cmd/tui/main.go`
  (`renderHook`)
- User's hooks: `ls ~/.claude/hooks/*.sh`
