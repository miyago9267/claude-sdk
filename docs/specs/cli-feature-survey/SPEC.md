# CLI Feature Survey & Adoption Plan（歷史規格）

> 本文件記錄已移除的 client CLI/TUI 產品面的研究，不代表目前 package surface 或待辦方向。

## What

逆向官方 `claude` (Claude Code) CLI 的功能表面，盤點 `@miyago/claude-sdk` 已涵蓋 / 該抄 / 該改 / 該略的項目，產出實作優先級供後續 sprint 取用。

**This is a research spec — not an implementation spec.** TASKS 階段才挑優先項目落實。

## Why

目前 `claude-sdk --tui` 和 `claude` 都長得像 Claude Code，但 user-visible UX (slash commands、pickers、`/init`、`/cost`、hooks 等) 我們只攔了一小撮，剩下都是 forward 給 SDK 內 cli.js 處理。要決定哪些「自家做」、哪些「靠 forward」，避免重做或漏做。

---

## Section 1 — Survey

### 1.1 CLI 旗標 (`claude --help` 全列表)

| 旗標 | 我方狀態 | 備註 |
|---|---|---|
| `-p, --print` | ✅ 已對齊 | boolean，positional 為 prompt |
| `--model` | ✅ 已對齊 + normalize | resolveModel 修常見 typo |
| `--system-prompt` / `--append-system-prompt` | ✅ 已對齊 |  |
| `--add-dir` | ✅ 已對齊 | comma-split |
| `--allowedTools` / `--disallowedTools` | ✅ 已對齊 |  |
| `--permission-mode` | ✅ 已對齊 |  |
| `--allow-dangerously-skip-permissions` | ✅ 已對齊 |  |
| `--max-turns` | ✅ 已對齊 |  |
| `--setting-sources` | ✅ 已對齊 |  |
| `--output-format` | ✅ 已對齊 | text / json / stream-json |
| `-c, --continue` / `-r, --resume` | ✅ Phase A+B done | local + official jsonl 雙向 |
| `-d, --debug` | ⚠️ 解析但沒接通 cli.js | forward 給 SDK 即可，無實作 |
| `--verbose` | ⚠️ 解析但沒接通 |  |
| `-v, --version` | ✅ |  |
| `--mcp-config` | ❌ unsupported | SDK 已支援，需把 args wire 到 sessionOptions.mcpServers |
| `--ide` | ❌ unsupported | IDE 整合，VS Code extension 那條路，工作量大 |
| `--worktree`, `-w` | ❌ unsupported | git worktree 管理 |
| `--plugin-dir` | ❌ unsupported | 應 wire 到 sessionOptions |
| `--tools` | ❌ unsupported | 跟 --allowed/--disallowed 重疊 |
| `--agent` / `--agents` | ❌ unsupported | sub-agent 設定 |
| `--effort` | ❌ unsupported | thinking budget level |
| `--betas` | ❌ unsupported | beta API headers |
| `--bare` / `--brief` | ❌ unsupported | minimal mode |
| `--from-pr` | ❌ unsupported | resume by PR number |
| `--json-schema` | ❌ unsupported | structured output |
| `--max-budget-usd` | ❌ unsupported | hard budget |
| `--no-session-persistence` | ❌ unsupported | with our store, mostly meaningless |
| `--session-id` | ❌ unsupported | force specific UUID — 配合官方 schema 後可實作 |
| `--settings` | ❌ unsupported | extra settings.json |
| `--input-format` | ❌ unsupported | stream-json input |
| `--include-hook-events` | ❌ unsupported | hook events in output |
| `--include-partial-messages` | ⚠️ 我們預設都打開了 |  |
| `--exclude-dynamic-system-prompt-sections` | ❌ unsupported |  |
| `--disable-slash-commands` | ❌ unsupported |  |
| `--fork-session` / `--fallback-model` | ❌ unsupported |  |

子命令 (subcommands)：

| 子命令 | 我方狀態 | 備註 |
|---|---|---|
| `agents` | ❌ | manage background / configured agents |
| `auth` | ❌ | manage authentication |
| `auto-mode` | ❌ | inspect auto mode classifier |
| `doctor` | ❌ | health check + auto-updater |
| `install` | ❌ | install native build |
| `mcp` | ❌ | configure / manage MCP servers |
| `plugin` / `plugins` | ❌ | manage plugins |
| `setup-token` | ❌ | long-lived auth token |
| `ultrareview` | ❌ | cloud multi-agent code review |
| `update` / `upgrade` | ❌ | self-update |

### 1.2 Slash Commands (`/...`)

從 cli.js 字串 grep + 我們已知的官方文件分類。** 標記 = 我們已自家實作；▷ 標記 = 我們 forward 給 SDK；○ = 不知道是否官方還是 plugin。

#### 對話控制
| Slash | 狀態 | 備註 |
|---|---|---|
| `/help` | ** TUI/REPL 自家 | 列出 TS-side 命令 |
| `/clear` | ** | 重啟 V2 session |
| `/exit` `/quit` | ** |  |
| `/compact` | ** | 強制 ContextManager compact |
| `/status` | ** | session id, ctx, cost |
| `/model` | ** | normalize + 切換 |
| `/cwd` | ** 自家擴充 | 官方無此命令 |
| `/self` | ** 自家擴充 | toggle self-edit |
| `/commands` `/skills` | ** 自家擴充 | 列已安裝 |

#### 官方有但我們沒做（值得抄）
| Slash | 推測功能 | 優先級 |
|---|---|---|
| `/cost` | 顯示 cost breakdown by model | **HIGH** |
| `/init` | 產生 / 更新 CLAUDE.md | **HIGH** |
| `/agents` | browse + invoke sub-agents | MED |
| `/hooks` | 顯示 / 編輯 hooks 設定 | MED |
| `/memory` | 管理 ~/.claude/CLAUDE.md / memories/ | MED |
| `/resume` | 互動式 picker 列 sessions | **HIGH** |
| `/feedback` | 送 bug report 到 anthropic | LOW |
| `/release-notes` | show changelog | LOW |
| `/upgrade` | self-update | LOW |
| `/permissions` | 查看 / 修改 permission rules | MED |
| `/branch` | git branch operations | LOW |
| `/effort` | 切 thinking budget (low/med/high/max) | MED |
| `/fast` | 切 fast mode (Opus 4.6) | LOW |
| `/ide` | connect to IDE | SKIP |
| `/install-github-app` | GitHub bot setup | SKIP |
| `/mcp` | manage MCP servers | LOW |

#### Plugin / Skill 帶來的
- `/sentry-feature-setup`、`/skill-name`、`/init-ai-dir` 等 — 透過 `/skills` discovery 我們已能看到，invoke 走 forward。不需自家實作。

### 1.3 Session JSONL Record Types (我們未來可能要寫 / 讀)

從 `~/.claude/projects/-Users-miyago-Project-AI-claude-sdk/<id>.jsonl` 觀測到 25 種 type：

| type | 我們狀態 | 處理方向 |
|---|---|---|
| `permission-mode` | ✅ 寫入 | header line |
| `user` / `assistant` | ✅ 雙向 | 但 content 是 string，未保留 block array |
| `text` / `thinking` | ❌ 未保留 | 出現在 message.content 內 |
| `tool_use` / `tool_result` | ⚠️ 攤平成 text | **應保留 block array**（之前 phase B 的 TODO） |
| `system` | ❌ | system reminder injections |
| `attachment` | ❌ | image/file paste |
| `hook_success` | ❌ | hook 跑完的 record |
| `task_reminder` | ❌ | TodoWrite 提醒 |
| `skill_listing` | ❌ | skill discovery 結果 |
| `mcp_instructions_delta` | ❌ | MCP server messages |
| `file-history-snapshot` | ❌ | 檔案備份，可 /undo |
| `edited_text_file` | ❌ | Edit/Write 操作 record |
| `last-prompt` | ❌ | 重發上一個 prompt 用 |
| `previous_message_not_found` | ❌ | 錯誤 marker |
| `unavailable` | ❌ | tool unavailable |
| `update` | ❌ | sdk update notice |
| `date_change` | ❌ | system reminder：日期變更 |
| `direct` | ❌ |  |
| `deferred_tools_delta` | ❌ | deferred tool execution |
| `create` | ❌ |  |
| `message` / `agents` | ❌ |  |

### 1.4 `~/.claude/` 子目錄盤點

| 目錄 | 用途 | 我們是否該知道 |
|---|---|---|
| `projects/` | session jsonl 集中地 | ✅ Phase B 已寫入/讀取 |
| `commands/` | user-level slash commands | ✅ discoverCommands |
| `skills/` | user-level skills | ✅ discoverSkills |
| `agents/` | user-defined agents | ❌ 未 discover |
| `plugins/` | installed plugins | ✅ discoverCommands 走 plugins |
| `memories/` | 個人 memory bank（feedback/profile） | ❌ |
| `memory/` | model-managed memory | ❌ |
| `hooks/` | shell scripts triggered by hook events | ❌ |
| `file-history/` | 檔案備份 | ❌ |
| `handoffs/` | session handoff markdown | ❌（我們 .ai/ 自有） |
| `session-env/` | 每 session env vars | ❌ |
| `mcp-needs-auth-cache.json` | MCP OAuth state | ❌ |
| `paste-cache/` | 貼上的圖片/檔案 | ❌ |
| `exports/` | session export | ❌ |
| `downloads/` | tool 下載檔 | ❌ |
| `backups/` | settings 備份 | ❌ |
| `cache/` | sdk cache | ❌ |
| `debug/` | debug log | ❌ |
| `ide/` | IDE bridge state | ❌ |
| `scripts/` | user automation scripts | ❌ |
| `rules/` | user-defined rule files | ❌ |
| `history.jsonl` | 全域 prompt history（Up arrow recall） | ❌ |
| `CLAUDE.md` | 全域 system prompt | ✅ 透過 settingSources 已載入 |
| `RTK.md` | 個人 rule pack | ✅ 透過 @-import |
| `settings.json` (推測) | 全域設定 | ❌ |

### 1.5 Hook Events

cli.js 內建 9 種 hook events：

```
PreToolUse, PostToolUse, Stop, SubagentStop,
SessionStart, SessionEnd, UserPromptSubmit,
PreCompact, Notification
```

cli.js 跑時自動處理 user `~/.claude/hooks/*.sh` 跟 settings.json 中的 hook 設定。**我們透過 V2 session 已自動繼承這個能力**，不用自家實作。但 hook 觸發的記錄 (`hook_success` jsonl record) 我們目前 ignore，TUI 可以顯示「[hook] X fired」之類。

### 1.6 內建 Tools

Bash / Read / Write / Edit / Glob / Grep / Agent / WebSearch / WebFetch / Task (TodoWrite) / NotebookEdit / Skill (run sub-skill) / etc — 全在 cli.js 內，V2 session 自帶，我們無須重做。

---

## Section 2 — Recommendations

### HIGH (下一波就抄)

1. **`/cost`** — show cost breakdown by model + cumulative。  
   *Why*：user 已有此心智模型，statusLine2 已顯示 cost 但無 detail。
2. **`/resume` interactive picker** — TUI popup 列出 local + official sessions，含 model / lastUsed / turnCount，方向鍵選 + Enter resume。  
   *Why*：phase A/B 做完後，pickup 入口缺。
3. **`/init`** — 產 CLAUDE.md。  
   *Why*：新專案啟動 ergonomic，user 已習慣。
4. **Tool block round-trip in jsonl mirror** — phase B TODO，保留 `tool_use` / `tool_result` block arrays 而非攤成 text。  
   *Why*：official `claude -r` 拿不到 tool 過程。

### MED (再下一波)

5. **`/agents` browser** — 列 ~/.claude/agents/ + 專案內 .claude/agents/，可 invoke。  
   *Why*：sub-agent 是官方主推工作流。
6. **`/memory`** — 列 / 編輯 ~/.claude/memories/ 跟 ~/.claude/CLAUDE.md。
7. **`/permissions`** — 顯示 / 修改 permission rules。
8. **`/effort`** — 切 thinking budget。透過 sessionOptions.thinkingConfig，已 patch。
9. **`/hooks`** — 顯示 hooks 設定，TUI 內 trace hook 觸發 (`hook_success` jsonl record)。
10. **`--mcp-config` / `--plugin-dir` wire-through** — 我們 args 已 parse 但忽略，把它接到 sessionOptions。
11. **TUI `bug:` resume status** — alt-screen 吞掉 stderr 的 resume 訊息（handoff pending）。
12. **Dirty marker reactivity** — turn 結束後重 sample git status（handoff pending）。
13. **`history.jsonl` integration** — REPL/TUI Up arrow recall 上次 prompt。

### LOW (有空再做)

14. `/feedback`、`/release-notes`、`/upgrade`、`/branch`、`/fast`
15. `--from-pr`：resume from GitHub PR
16. `--bare` / `--brief`：minimal mode
17. `--json-schema`：structured output
18. session export (`exports/`)、file-history (`/undo`)、attachment 處理
19. `subcommands`：`doctor`、`auth`、`mcp`、`plugin` 子命令

### SKIP (不做或交給官方)

- `/ide` / `--ide`：IDE bridge — 這是 VS Code extension 的活
- `/install-github-app`：GitHub bot 設定，跟我們無關
- `auto-mode` 子命令：classifier 內部
- `setup-token`：auth flow 我們不碰
- 內建 tools：cli.js 自帶
- Hook 機制本身：cli.js 自帶（只考慮 surface 顯示）
- Permission UI：我們預設 bypassPermissions，不重做 prompt UI

---

## ADR

### ADR-1: 不重做 hook 機制本身，但 surface hook 觸發

**Decision**：cli.js 已內建 9 種 hook events 並會跑 user 的 `~/.claude/hooks/*.sh`。我們不重做，但 TUI 解析 jsonl 的 `hook_success` 等 record，dim 顯示「[hook] X fired」，讓 user 看見。

### ADR-2: Tool block 雙向轉換優先於其他 phase B 細節

**Decision**：phase B 寫官方 jsonl 時 tool blocks 攤平 — 這是已知缺陷。**HIGH-4 優先**完成這個，否則 official `claude -r` 看不到 tool 過程，互通性打折。

### ADR-3: `/init` 沿用 SDK 內建邏輯

**Decision**：cli.js 自有 `/init` slash command。我們不自家寫產 CLAUDE.md 的邏輯，**直接 forward**。但 TUI 可加 confirmation banner。我們的「自家實作 / forward」策略：純 UI 優化（picker、format）就抄，模型驅動的內容生成就 forward。

### ADR-4: `/cost` 不依賴 jsonl 解析，從現有 ContextManager state + cumulative cost 算

**Decision**：`/cost` 顯示我們已 track 的 turn-by-turn cost、by-model breakdown，不去讀官方 jsonl 統計（避免雙來源不一致）。要更精準的 quota 才去讀 official。

---

## Section 3 — Phase C: Event Surface (skill / hook / mcp + animation polish)

User 指定的下一波目標：把「目前 cli.js 內部跑了什麼」攤到 TUI 上。我們現在
只 render `tool_use` / `tool_result`，但 SDK stream 其實還吐：

| SDK message | subtype | 我們狀態 | 該顯示的 |
|---|---|---|---|
| `SDKHookStartedMessage` | system / `hook_started` | ❌ ignore | `⚙ hook PreToolUse · tty-respond.sh` |
| `SDKHookProgressMessage` | system / `hook_progress` | ❌ | append stdout/stderr 摘要 |
| `SDKHookResponseMessage` | system / `hook_response` | ❌ | `⚙ hook ... ✓ done (Xms)` |
| `SDKTaskStartedMessage` | system / `task_started` | ❌ | `▸ task <desc> · type=…` |
| `SDKTaskProgressMessage` | system / `task_progress` | ❌ | spinner + elapsed + tool_uses |
| `SDKTaskNotificationMessage` | system / `task_notification` | ❌ | `▸ task ✓/✗ <summary>` |
| `SDKToolProgressMessage` | `tool_progress` | ❌ | tool_use 旁加 elapsed `(12s)` |
| `SDKToolUseSummaryMessage` | `tool_use_summary` | ❌ | 折疊一連串 tool 為一句話 |
| `tool_use` 名 = `mcp__<srv>__<tool>` | (existing) | ⚠️ render 一視同仁 | 顯示 `mcp:codex exec` 並染 server 顏色 |
| `tool_use` 名 = `Skill` | (existing) | ⚠️ | 顯示 `🅼 skill <name>`（從 input 取 skill name）|
| jsonl `skill_listing` record | — | ❌ | inline 顯示載入 N 個 skill |
| jsonl `hook_success` record | — | ❌ | （冗餘 — 跟 SDK hook_response 重複，二選一） |

### Phase C.1 — IPC schema 擴充

新 HostEvent types (TS → Go):

- `hook` — { hookEvent, hookName, status: 'started'|'ok'|'err', durationMs?, summary? }
- `task` — { taskId, description, status: 'started'|'progress'|'completed'|'failed'|'stopped', elapsedSec?, tokens?, summary? }
- `tool-progress` — { id, elapsedSec } (existing tool-use line gets timer overlay)
- `mcp-call` — { server, tool, id, input } (取代部分 tool-use 邏輯，當 name 開頭 `mcp__`)
- `skill-call` — { name, id } (取代部分 tool-use 邏輯，當 name 是 `Skill`)

### Phase C.2 — Go render

新 transcript line 風格（lipgloss palette）:

- `⚙ hook PreToolUse · tty-respond.sh` — 暗紫，hook event 名加色標
- `▸ task spec-writer · 12s · 4 tool_uses` — 青色 + spinner overlay during task progress
- `🅼 skill dev-discipline:tdd-guide` — 黃色
- `mcp:codex exec({"command":"ls"})` — server 名按字串 hash 上色，跟普通 tool 區分
- 既有 `⏺ Bash(...)` / `✓` / `✗` 不變

### Phase C.3 — 細碎動畫

| 元素 | 現狀 | Phase C 後 |
|---|---|---|
| Spinner | 只在 `busy=true` footer | 各 task / tool 旁也輪一個 mini spinner |
| Tool elapsed | 無 | 每個未完成 `⏺` 後面顯示 `(12s)`，1s tick 自更新 |
| Welcome logo | 靜態 ASCII | 開場 fade-in（lipgloss adaptive color，分 3 frames） |
| Hook fired | 無 | 出現時先閃白 200ms 再轉灰 |
| Cursor blink | 預設 textarea blink | OK，不改 |
| User prompt 送出 | 無 | 送出瞬間 input box border 閃綠 200ms |

### Phase C.4 — 驗證點

- 跑一個會觸發 hook 的 tool（user 有 `markdown-lint-fix.sh` 等 PostToolUse 設定）→ 應看到 `⚙ hook PostToolUse`
- `mcp__codex__*` 工具呼叫應顯示為 `mcp:codex` 變色行
- `Task` tool（內建 sub-agent dispatcher）應觸發 `task` event 流，顯示 task 進度

### ADR-5: Phase C 訊號是 view-only，不改 LLM 行為

我們只觀察 SDK stream 然後 render，不改變 hook / skill / mcp 的觸發機制 —
那是 cli.js 自己的事。我們只是把它「演」給 user 看。

### ADR-6: MCP / Skill 呼叫從 tool_use 分流，不另開 SDK 通道

判別邏輯靠 tool_use.name 前綴：
- `mcp__<server>__<tool>` → 走 `mcp-call` event
- `Skill` (內建 dispatcher) → 走 `skill-call` event，skill name 從 `input.skill` 取
- 其他 → 維持 `tool-use`

這樣 IPC 數量不爆，TS 端只在 forward 時做 routing。

## Section 4 — Phase D: Interactive Pickers

User 指定的下一波目標：把官方 cli.js 那種「請選 A/B/C」的決策互動拉到我們
TUI 上 — plan mode、permission prompt、resume picker、elicitation 等。

### 4.1 Picker primitive

通用 modal selector，所有「需要 user 從一組選項挑一個」的場景都用它：

- IPC：`EvtAsk` (HostEvent) payload = `AskRequest{ id, kind, question, hint?, options[] }`
  反向 `UIAnswer` (UIEvent) = `{ askId, value, cancelled }`
- Go 端 `pickerState` 接管 keyboard，View 時覆蓋 viewport 與 popup
  - ↑/↓ 選 · 任意字 type-to-filter · Enter accept · Esc cancel · Ctrl+C exit
- TS 端 `askUser(req): Promise<AskResult>` 包 sendToTui + Map<askId, resolve>

### 4.2 First use case — `/sessions`

Slash command 列當前 cwd 內的 local + official sessions（去重 by id），按
`lastUsedAt` 排序，picker 選一個 → 自動 import 進 local store（如果是 official-only）
→ restart V2 session + queue history prefix。等同於 GUI 版的 `claude -c`。

### 4.3 後續 picker 接點

| Use case | Trigger | Picker shape |
|---|---|---|
| `/agents` | slash | select from discovered agents |
| `/permissions` | slash | confirm allow/deny rules |
| `canUseTool` (plan mode) | SDK callback | confirm tool execution per call |
| MCP elicitation | `onElicitation` callback | form (text input) — picker.kind='text' |

V2 SDKSessionOptions 目前**沒** `onElicitation`（只在 query Options 上），
所以 elicitation 接通需要等 SDK 補或我們繞道（攔 SDK_system events）。
canUseTool 也需要 user 切離 `bypassPermissions` 模式才會被觸發。先做手動
觸發的（`/sessions`、未來 `/agents`）。

### ADR-7: Picker primitive 為共享元件，不為單一 caller 客製

**Decision**：`pickerState` + `EvtAsk` + `UIAnswer` 是共用層，所有 caller
（自家 slash command / SDK callback）走同個 IPC 形狀。Go 不知道 caller 是誰，
TS 用 askId 路由 resolve。

**Rationale**：避免每個新 callsite 在 TUI 重做選擇器。schema 簡單到
JSON-encoded payload 一個 string field 就涵蓋所有變體。

### ADR-8: Picker 的 text 模式留待真正有 caller 才實作

`AskRequest.kind = 'text'` 已預留但 picker 尚未 render textarea。第一個
text caller 出現時再加（很可能是 elicitation form 模式）。

## Section 5 — External Reference Cross-check

User-pointed reference: `luongnv89/claude-howto/zh/10-cli/README.md` (民間整理的
Claude Code CLI 文件，2026-05 抓取)。把它的描述跟 cli.js 內部實際對一遍。

### 5.1 Doc 跟 cli.js 對得上的部分

- 三種 mode（REPL / `-p` print / `-c|-r` resume）— 對應 §1.1
- Subagent 優先順序 CLI > user > project — 跟我們的 discoverAgents 順序一致
- `--fork-session` 描述對得上：resume 時生新 session id 而非沿用 — 跟
  sdk.d.ts 一致
- `--effort` 是 thinking budget（low / medium / high / xhigh / max）—
  之前 UNSUPPORTED，未來可加 `/effort` slash + 接 sessionOptions.thinkingConfig
- `--fallback-model` 是 overload 自動 fallback，**只在 `-p` 生效**

### 5.2 Doc 提到但 cli.js grep 不到的部分

doc 可能是抽象描述而非實際 var 名，引用前要驗：

| Doc 說的 | cli.js grep 結果 |
|---|---|
| `--disable-auto-checkpoints` flag | 找不到 |
| `CLAUDE_MODEL` env var | 找不到（實際是 `ANTHROPIC_MODEL`） |
| `CLAUDE_EFFORT` env var | 找不到 |
| `CLAUDE_WORKING_DIRECTORY` | 找不到 |
| `CLAUDE_OUTPUT_FORMAT` | 找不到 |
| `claude auth login/logout/status` | `auth` 子命令存在，但 login/logout/status 子動作沒 grep 到字面字串 |
| Auto-checkpoint UI | 找不到對應字串 |

結論：doc 可信度中等，引用 env var 名前先 grep 確認。

### 5.3 cli.js 真實環境變數（節選）

`ANTHROPIC_*`：API_KEY / AUTH_TOKEN / MODEL / BASE_URL / DEFAULT_(OPUS|SONNET|HAIKU)_MODEL
/ AWS_(BASE_URL|API_KEY|WORKSPACE_ID) / BEDROCK_BASE_URL / FOUNDRY_(API_KEY|BASE_URL|AUTH_TOKEN|RESOURCE)
/ CUSTOM_(HEADERS|MODEL_OPTION*) / BETAS / LOG / ...

`CLAUDE_*`：API_KEY / CODE_(ACCOUNT_UUID|ACTION|AGENT_NAME|API_BASE_URL|ATTRIBUTION_HEADER|...)
/ AGENT_SDK_(CLIENT_APP|DISABLE_BUILTIN_AGENTS|MCP_NO_PREFIX|VERSION) / AUTOCOMPACT_PCT_OVERRIDE
/ AUTO_BACKGROUND_TASKS / AFTER_LAST_COMPACT / BASH_MAINTAIN_PROJECT_WORKING_DIR / ...

我們已用：`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_REMOTE`（patches/RECOMMENDED_SUBPROCESS_ENV）。

### 5.4 從 cross-check 浮現的候選工作

| Item | 優先級 | 備註 |
|---|---|---|
| `/effort` slash + thinkingConfig wire | MED | thinkingConfig 我們在 V2 patch 已 unlock，wire 到 args / slash 即可 |
| `--fallback-model` 接通 | LOW | 只 `-p` 生效，使用者場景少 |
| `--fork-session` 接通 | LOW | 跟我們的 logical id 系統衝突，需設計 |
| 多 provider env vars (Bedrock / Foundry) | SKIP | 走 SDK 內部，使用者直接設 env 即可 |
| `claude auth status` 對等命令 | LOW | 確認登入狀態 — 可加 `/auth` slash 顯示當前 token / quota |

### ADR-9: 不直接抄民間 doc 的字面描述

對於外部 reference 文件，先用 grep / `--help` / SDK type 對核實再採用。
之前發現 doc 列的 `CLAUDE_MODEL` / `CLAUDE_EFFORT` env vars cli.js 找不到，
若照抄會做出 user 無法 trigger 的功能。

## Out of Scope

- 重做 cli.js 任何核心功能（permission system、tool dispatcher、hook engine）
- IDE 整合（VS Code extension）
- Native build / installer / self-update
- Auth flow / MCP OAuth
- Multi-tenant / team 功能

---

## Open Questions

1. `/effort` 切 thinking budget — V2 session 是否支援動態切？還是要 restart session？
2. cli.js 自身的 `/init` 內容是否會寫進我們 mirror 的官方 jsonl？需要驗證。
3. `history.jsonl` 是否有 schema doc，還是要 reverse engineer？
4. 我們「自家 slash」（`/cwd` `/self` `/commands` `/skills`）跟官方無衝突，但官方未來可能加同名命令 — 要不要前綴 `:claude-sdk:`？

---

## Next

待 user 從 Recommendations 圈出第一批 (預設 HIGH 4 個)，建 TASKS.md 進實作。
