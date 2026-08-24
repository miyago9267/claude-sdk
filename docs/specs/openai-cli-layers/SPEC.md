# OpenAI Adapter + CLI Harness（歷史規格）

> 本文件記錄 client CLI/TUI 時期的設計決策。CLI、Bubbletea TUI 與相關 package exports 已移除；目前請以 `src/ollama/` 的 protocol bridge 與 README 為準。

> **STATUS: SUPERSEDED (2026-04-29)** — `src/openai/` removed in favour of
> `docs/specs/ollama-bridge/`. The CLI Harness + Bubbletea TUI portions of
> this spec (Layer 2 / Layer 2.5) are still in effect; only the OpenAI
> adapter (Layer 1) is gone. See ollama-bridge SPEC ADR-6 for rationale.

## What

在現有 `@miyago/claude-sdk` 之上加兩層：

1. **OpenAI Adapter (`./openai`)** — Hono server，提供 OpenAI Chat Completions 兼容 endpoint 給外部工具（GitHub Copilot 等）使用。
2. **CLI Harness (`./cli`, `bin: claude-sdk`)** — 命令列 wrapper，整合 V2 session + ContextManager，內建 tool execution chain。

## Why

- 既有 patched SDK（V2 persistent session + cache 91%）在 Node API 層只服務 TS app；外部 IDE / IDE 插件需要 HTTP 介面才能接入。
- 直接 expose 一個 OpenAI 兼容 server 等於把 Claude Max 訂閱額度透過 OpenAI 介面分享給任何兼容工具。
- CLI 是常用形態，順手做。

## ADR

### ADR-1: Layer 1 用 stateless 模式（每 request 一個 V2 session）

**Decision**: 每個 `/v1/chat/completions` request 開新 V2 session、跑完即關。

**Rationale**:
- OpenAI Chat Completions 本來就是 stateless（client 帶完整 messages），語意對齊。
- Copilot inline completion 場景上下文短，cache 收益有限。
- 實作大幅簡化。

**Trade-off**: cache 紅利從 91% 降回 25-30%。日後若需要長對話 cache，可加 session pool by messages-prefix-hash（不影響介面）。

### ADR-2: Layer 1 server-side tool execution

**Decision**: SDK 內建 tool（Read/Write/Bash/...）由 server 端執行，client 只看到最終 assistant 文字 + tool_calls 摘要。

**Rationale**:
- Claude Agent SDK 設計就是 SDK 自跑 tool 的 chain。要把 tool_use 翻給 client 執行，需要中斷 SDK chain、等 client 回 tool_result、再 inject — V2 session 不支援 inject 歷史，做不出來。
- Server-side 執行對 Copilot chat 場景已夠用（client 只要結果）。

**Trade-off**: client 看不到 tool 過程，無法干預。SDK 的 tool_use block 在 streaming 期間仍會以 OpenAI `tool_calls` 形式 forward 給 client（read-only），但結果會被 server 自己消化。

### ADR-3: Layer 2 CLI 用 V2 session + ContextManager

**Decision**: `claude-sdk` bin 預設啟動 V2 persistent session，REPL 模式互動；若有 stdin pipe 或 `-p` 參數則一次性執行。

**Rationale**:
- V2 session 才能享受 cache 紅利（CLI 互動是長對話場景）。
- ContextManager 自動處理 watermark / keepalive。

### ADR-4: TUI 走 Go bubbletea + NDJSON IPC

**Decision**: `--tui` 模式下 spawn `bin/claude-sdk-tui`（Go 寫的 bubbletea 應用），透過 stdin/stdout NDJSON 雙向溝通。TS 端只跑 LLM session，Go 端只負責 render 和 input。

**Rationale**:
- Bubbletea / lipgloss 是目前 TUI 生態最成熟的方案，TS 沒有同等替代品（ink 的 React-based 重度且渲染弱）。
- 跨 process 邊界乾淨，Go binary 升級不動 TS 版本，反之亦然。
- TS 仍持有所有 LLM / patched SDK / ContextManager 邏輯，TUI 只是 view 層。

**Trade-off**:
- 需要 Go 工具鏈才能 build TUI binary。MVP 不在 npm 包出 binary，user 自己跑 `bash scripts/build-tui.sh`。
- IPC 協定需要在兩邊手動同步（schema 在 `cmd/tui/ipc.go` + `src/cli/tui.ts`）。

## Alternatives

| 方案 | 為何不採用 |
| --- | --- |
| Layer 1 用 V1 query 重放 messages | V1 cache 效率低，且 messages 重放等於 stateless。沒比 V2 stateless 好。 |
| Layer 1 client-side tool execution | V2 session 不支援 inject 歷史 tool_result，技術上做不出來；除非繞過 agent SDK 直接打 native API（失去所有 patched 紅利）。 |
| CLI 用 commander/cac | 引入額外依賴，輕量解析 process.argv 已夠用。 |

## Rabbit Holes

- **Tool name 對應**：OpenAI 用 function name 是任意字串；Claude 內建 tool 名稱固定（Read, Write, Bash...）。Copilot 若以 OpenAI 介面定義 functions 給我們，server 端忽略（用 SDK 自帶 tools 即可）。
- **Stop reason 對應**：Claude 的 `end_turn` → OpenAI `stop`；`tool_use` → OpenAI `tool_calls`；`max_tokens` → `length`。
- **Auth**：MVP 不做 auth；listen 127.0.0.1 only。

## Out of Scope

- Embeddings endpoint
- Function calling 給 client 執行（看 ADR-2）
- 多 user / API key 管理
- Long-conversation session pool（留待 v2）
