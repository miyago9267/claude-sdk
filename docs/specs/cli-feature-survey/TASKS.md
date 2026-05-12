# Tasks

## Survey (done)

- [x] CLI flags 對比表
- [x] Slash command grep + 分類
- [x] JSONL record types 統計
- [x] `~/.claude/` 子目錄盤點
- [x] Hook events 列表
- [x] Recommendations + ADR
- [x] Phase C event surface 擴充章節

## Phase C — Event Surface (current batch)

### C.1 IPC schema

- [x] `cmd/tui/ipc.go` — HostEvent 加 `hook`, `task`, `tool-progress`, `mcp-call`, `skill-call` types
- [x] 對應欄位：`HookEvent`, `HookName`, `HookStatus`, `DurationMs`, `TaskID`, `TaskStatus`, `TaskDescription`, `ElapsedSec`, `Tokens`, `McpServer`, `McpTool`, `SkillName`

### C.2 TS forwarder

- [x] `src/cli/tui.ts` — `forwardToolUse` 拆 routing（Skill / mcp__ / 其他）
- [x] runTurn stream loop 處理 system hook_started/hook_response/task_started/task_progress/task_notification + tool_progress
- [x] HostEvent interface 加 phase C fields

### C.3 Go render

- [x] `cmd/tui/main.go` — applyHostEvent 加 5 個新 case (`EvtHook`, `EvtTask`, `EvtToolProgress`, `EvtMcpCall`, `EvtSkillCall`)
- [x] `renderHook(event, name, status, durationMs)` — `⚙ PostToolUse · markdown-lint-fix.sh ✓ 12ms`
- [x] `renderTask(desc, status, elapsedSec, tokens)` — `▸ task <desc> · 12s · 1.2K tok ✓`
- [x] `renderMcpCall(server, tool, input, status, elapsed)` — server 名 hash 5 色 palette
- [x] `renderSkillCall(name, status, elapsed)` — yellow badge
- [x] toolEntry 加 `startedAt` / `done` / `kind`，1s tick `refreshActiveTools()` 重 render pending 行加 `(Ns)`
- [x] taskByID 同樣機制，progress 期間 elapsed 自更新

### C.4 Animation polish

- [x] Tool elapsed overlay (1s tick auto-refresh)
- [x] Welcome logo 3-frame fade-in (240 → 60 → 99 → 63 via welcomeTickMsg)
- [x] Hook fired flash: 'NEW' badge prefix, scheduled fade after 400ms
- [x] User send flash: input box border tints green for 220ms after Enter

### C.5 Verification

- [x] Build green：`bash scripts/build-tui.sh` + `bun test src/` (156 pass)
- [ ] 手測：呼叫 `mcp__codex__*` 應看到 `mcp:codex` 行 — 待 user 跑
- [ ] 手測：跑 `Edit *.md` 觸發 `markdown-lint-fix.sh` 應看到 `⚙ hook PostToolUse`
- [ ] 手測：用 `Task` tool 跑 sub-agent 應看到 task 進度

## Phase D — Interactive pickers

- [x] D.1 Picker primitive (Go): `pickerState`, `picker.go` view + filter, `handlePickerKey`
- [x] D.2 IPC: `EvtAsk` + `AskRequest` payload, `UIAnswer` event, schema synced both sides
- [x] D.3 TS host: `askUser(req): Promise<AskResult>`, `pendingAsks` map, answer routing
- [x] D.4 First caller: `/sessions` lists local + official sessions, picker → resume
- [x] D.5 `/agents` picker — discover.ts gains discoverAgents, /agents shows description + usage hint
- [x] colour pass — saturated palette + status bar background
- [ ] D.6 canUseTool (plan-mode-like confirm) when permission mode != bypassPermissions
- [ ] D.7 MCP elicitation接通（V2 SDKSessionOptions 沒 onElicitation，需繞道）
- [ ] D.8 picker.kind='text' 真正能輸入（目前佔位）

## 後續批次（暫不展開）

- HIGH 1: `/cost`
- HIGH 2: `/resume` interactive picker
- HIGH 3: `/init`
- HIGH 4: tool block round-trip in jsonl mirror
- MED items（見 SPEC §2）
