# Claude Agent SDK timeline

這份文件整理本 repo 從 forked SDK 到目前 wrapper 的演進。版本與日期以 git history、目前 source 和 lockfile 為準。

## 現況

目前使用 `@anthropic-ai/claude-agent-sdk` `0.3.238`，直接依賴官方 package；package 內含對應的 Claude Code runtime。repo 自己維護的是 application harness，不再修改 SDK bundled `sdk.mjs` 或 `cli.js`。

### 保留中的 repo 層能力

| 能力 | 位置 | 作用 |
| --- | --- | --- |
| Persistent session adapter | `src/shared/query-session.ts` | 將官方 `query()` streaming-input 包成 `send / stream / close` |
| Context lifecycle | `src/context-manager.ts` | watermark、handoff、compact、restart、cache keepalive、rapid-refill breaker |
| Usage semantics | `diffCumulativeModelUsage()` | 把新版 SDK 的 cumulative `modelUsage` snapshot 轉成 per-turn delta，處理 session reset |
| Cache utilities | `src/optimize/cache-optimizer.ts` | 穩定 tool/agent option 順序、觀察 cache hit rate；不負責開啟 SDK cache |
| Context / budget utilities | `src/optimize/` | model routing、token tracking、subagent context hook、budget enforcement |
| External surfaces | `src/ollama/` | Ollama/OpenAI protocol bridge，從 agent host process 啟動 |

## 時間線

### 2026-03-17 — v0.1.0：fork 官方 SDK 0.2.76

最初把官方 SDK package fork 進 repo，beautify 約 53 萬行 `cli.js`，加入 5 個內部 patch：

1. SDK mode 啟用 prompt-cache beta/cache editing。
2. 主 fork context 只保留最近 5 輪。
3. subagent fork context 只保留最近 5 輪。
4. streaming fallback 已收到 content 時保留已完成 blocks，避免整段重送。
5. context overflow safety margin 降低，並加入 near-full telemetry。

### 2026-03-17 — v0.2.0：升級到 agent-sdk 0.2.77

重新產生整份 bundled `cli.js` 與型別檔，手動維持上述 patch。此時 SDK 仍使用 experimental `unstable_v2_createSession()`。

### 2026-03-18～03-27 — v0.3.x wrapper 能力形成

加入 `ContextManager` 與相關修正：

- handoff summary → 新 session、compact、restart 三級策略。
- cache keepalive，並在 keepalive 後重新檢查 watermark。
- cumulative usage snapshot diff；session reset 時不產生負 delta。
- compact 後重設 context estimate，避免歷史 token 持續累加。
- rapid-refill breaker，避免連續 compact 造成 thrashing。

同一階段也加入 model routing、token tracking、cache hit monitoring、context pruning，後來合併到 core package 的 `src/optimize/`。

### 2026-04-03 — v1.2.0：regex-based V2 patcher

將手動 patch 改成 `scripts/patch-v2.mjs`，依 minified code 結構尋找變數，而不是依賴固定 minifier 名稱。這版主要修補 `unstable_v2_createSession()` 的 options passthrough：

- `settingSources`
- `cwd`
- `thinkingConfig`、`maxTurns`、`maxBudgetUsd`、`extraArgs`
- CLI-side `mcpServers`
- SDK MCP routing、`systemPrompt`
- `stderr` callback

這些 patch 的目的，是讓 V2 session 把型別上接受的設定真正傳到內部 `ProcessTransport`。

### 2026-04-29 — 對外 harness 擴張

加入本 repo 自己的外部介面，而不是再修改 Claude Code 核心：

- OpenAI-compatible HTTP adapter。
- Claude SDK CLI launcher 與 Bubbletea TUI + NDJSON IPC（後續已移除）。
- Ollama-native bridge，後來補上 OpenAI `/v1/*` surface。
- session pool，以 history prefix hash 做 LRU/TTL reuse，維持 warm session 與 cache prefix。

### 2026-06-16 — v0.3.177 migration：移除 reverse-engineered binary patch

官方 SDK 0.3.x 已提供公開 `query()` streaming-input API，取代 experimental V2 session；prompt caching 也成為官方 runtime 行為。repo 因此：

- 移除 forked `cli.js` / `sdk.mjs`。
- 移除 postinstall patcher 與 dead patch tooling。
- 以 `src/shared/query-session.ts` 保留原本呼叫端需要的 session interface。
- 將 usage snapshot diff 保留在 `ContextManager`，因為這是 application-level semantics，不是 binary patch。

### 2026-08-21 — 0.3.238 與雙層更新機制

- 更新 Agent SDK 到 `0.3.238`。
- 補齊 `@anthropic-ai/sdk` 與 `@modelcontextprotocol/sdk` peer runtime dependencies。
- CI/CD 每週檢查 npm latest，驗證後開 PR。
- Claude Code `SessionStart` hook 進 repo 時只讀檢查版本並提示，不自動修改工作樹。

## 已移除與仍需維護的邊界

不再維護：直接修改 SDK bundled `cli.js` 的 context margin、fork 裁剪、prompt-cache gate、streaming retry 等 0.2.x patch。

仍需維護：session adapter、context policy、usage accounting、bridge protocol、session pool，以及針對新版 SDK 的 compatibility tests。CLI/TUI 已從 package 與 source tree 移除；這些是本 repo 的 harness/product layer，不會因官方 SDK 提供同名底層能力就自動消失。
