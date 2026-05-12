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

- [ ] `cmd/tui/ipc.go` — HostEvent 加 `hook`, `task`, `tool-progress`, `mcp-call`, `skill-call` types
- [ ] 對應欄位：`hookEvent`, `hookName`, `hookStatus`, `taskId`, `taskStatus`, `elapsedSec`, `mcpServer`, `skillName`

### C.2 TS forwarder

- [ ] `src/cli/tui.ts` — runTurn 內 stream loop 加 5 種 system / tool_progress / tool_use_summary 的 routing
- [ ] tool_use name 偵測：`mcp__` 前綴 → `mcp-call`、`Skill` → `skill-call`、其他 → 既有 `tool-use`
- [ ] Hook 三種 sub-event (started / progress / response) 統合成單一 `hook` event 帶 status

### C.3 Go render

- [ ] `cmd/tui/main.go` — applyHostEvent 加 5 個新 case
- [ ] `renderHook(name, event, status, ms)` helper
- [ ] `renderTask(desc, status, elapsed, tokens)` helper
- [ ] `renderMcpCall(server, tool, input)` helper（server 名 hash 上色）
- [ ] `renderSkillCall(name)` helper
- [ ] tool elapsed overlay：`toolByID` 加 startedAt，每 1s tick 重 render `(Ns)`

### C.4 Animation polish

- [ ] Welcome logo 3-frame fade-in（lipgloss color cycle）
- [ ] Hook fired flash：appendLine 用 bright bg 200ms 後 refresh
- [ ] User send flash：input box border 短暫變綠

### C.5 Verification

- [ ] 手測：跑一個會 trigger PostToolUse hook 的操作（Edit *.md → markdown-lint-fix.sh）
- [ ] 手測：呼叫 `mcp__codex__*` 應看到 `mcp:codex` 行
- [ ] 手測：用 `Task` tool 跑 sub-agent 應看到 task 進度
- [ ] tests：純 helper render 函式不需互動，可加單元測試（renderHook / renderTask / renderMcpCall 邊界）

## 後續批次（暫不展開）

- HIGH 1: `/cost`
- HIGH 2: `/resume` interactive picker
- HIGH 3: `/init`
- HIGH 4: tool block round-trip in jsonl mirror
- MED items（見 SPEC §2）
