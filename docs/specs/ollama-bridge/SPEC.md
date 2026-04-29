---
title: Ollama Bridge — Claude SDK as Local Ollama Server
slug: ollama-bridge
status: draft
created: 2026-04-29
updated: 2026-04-29
owner: miyago
---

# Ollama Bridge

## What

在 `@miyago/claude-sdk` 之上加一個 sub-module `./ollama`，跑一個 Hono server 模擬 Ollama 原生 HTTP API（`/api/chat`、`/api/tags`、`/api/show`、`/api/version`），讓 GitHub Copilot Chat 的 BYOK / Manage Models 流程可以把 Claude 當成本地 Ollama 模型接進去。

## Why

- Copilot Chat 在 VS Code 的 BYOK 入口本來就支援「Ollama (local)」provider，免裝額外擴充、免改設定檔，使用者只要 `serve --ollama` 就接得進去。
- 既有的 `./openai` adapter 走 OpenAI 兼容路徑，但 Copilot 對 OpenAI-compatible custom model 的支援還在 Insiders；走 Ollama 原生協定路徑更穩、發行通路也廣。
- 內部 reuse 既有 V2 session + ContextManager + transform 純函式，新增量不大。
- 用 Claude Max 訂閱額度跑 Copilot Chat / Agent，省 API key 錢。

## ADR

### ADR-1：Hybrid 協定 — discovery 走 Ollama 原生，chat 走 OpenAI compat（SSE）

**Decision**: bridge 同時提供兩套路徑：
- **Discovery**：`/api/version`、`/api/tags`、`/api/show` 走 Ollama 原生（JSON）
- **Chat**：`/v1/chat/completions`（SSE 串流，`data: {...}\n\n` + `[DONE]`）+ `/v1/models`
- `/api/chat`（Ollama 原生 NDJSON）保留供 curl/scripts 使用，但 stream=true 仍未實作（Phase 2 再決定要不要做）

**Rationale**:
- 實測發現 VS Code Copilot 的 `OllamaLMProvider` 雖然叫 Ollama，但繼承 `AbstractOpenAICompatibleLMProvider`，chat 真的打的是 `${baseUrl}/v1/chat/completions`，只有 model discovery 走 Ollama 原生。
- 原本的 ADR-1（純 Ollama NDJSON）會讓 chat 完全收不到 request（Copilot 從沒打過 `/api/chat`），表現上是 `net::ERR_CONNECTION_REFUSED` 或 fetch fail。
- 兩個 surface 共享同一個 SDK call 路徑與 prompt builder（`shared/messages.ts`），增加的程式碼集中在 wire format 序列化。

**Trade-off**:
- 維護兩套 streaming envelope（NDJSON 跟 SSE），但 NDJSON 那邊只有 non-stream 路徑活著，實際 surface 不大。
- Bridge 的「Ollama-ness」變得名實不符 — 我們其實是「Copilot-Ollama-provider compatible bridge」。

**Status**: accepted (2026-04-29 修正)

### ADR-2：Stateful session pool by client-history hash

**Decision**: 維護一個 in-memory LRU session pool。Key = `sha256(model + canonical(messages[0..n-1]))`，n = 最後一條 user message 的 index。命中時 reuse 該 V2 session 並只 `send(lastUserMessage)`；不命中或 verify 失敗則開新 session、replay 整段歷史。

**Rationale**:
- Copilot 每次都當 stateless 打（重發完整 history），但 V2 session 是 persistent 且自帶 prompt cache。對應上去能把 cache hit 從 0% 拉到接近 90%，省 token 也省回應時間。
- Hash 用 client-view（不含 server-side 跑掉的 tool_use/tool_result）才能穩定對應 — server 內部狀態 client 看不到，硬塞進 hash 會永遠 miss。

**Pool 行為**:
- Max 50 sessions、idle TTL 30 min、LRU evict
- Hit verify：對 session 維護一份 `lastClientHistoryHash`，命中後比對 client 給的 `messages[0..n-1]` hash 是否一致，否則視為 branch（同一 prefix 衍生出兩條對話）→ evict 舊的、開新的
- Cleanup：session `close()` 在 evict、TTL 到、process exit (SIGTERM/SIGINT) 時觸發

**Trade-off**: 
- 記憶體占用 O(50 × 一個 session) — 一個 idle V2 session 大概是一個 child process + IPC pipe，可接受
- 中斷的 streaming 可能讓 session 內部狀態不一致（client 砍 connection 但 server 已 commit 部分 turn）→ 中斷時主動 evict 該 session，不留給下次用

**Status**: accepted

### ADR-3：Server-side agent loop，動 bridge cwd（不是 IDE workspace）；transport 不 forward `tool_calls`

**Decision**:
- V2 session 的 maxTurns 預設 10，allowedTools 不限制（內建 Read/Write/Bash/Edit/Glob/Grep 全部可用）。
- SDK 在 server 端自跑 agent loop（model emit tool_use → SDK call internal tool → tool_result inject → 下個 turn → ...），動的是 **bridge process 啟動時的 cwd**。
- Transport 層（`StreamingChunkConverter`）drop 所有 `tool_use` blocks，不 forward 成 OpenAI `tool_calls`。Client 收到的是 model 多 turn 的 narrative text。
- `/api/show` 的 capabilities 仍 **不帶 `tools`** — Copilot Agent picker 不顯示 Claude，避免 user 誤以為它會動 IDE 真實 workspace 的檔案。

**Rationale (2026-04-29 修正 v3)**:
- ADR-3 v1（forward tool_calls 給 client 看）：Copilot 找不到對應 tool 報「The tool 'Bash' does not exist」。
- ADR-3 v2（chat-only，maxTurns 1, allowedTools []）：完全失去編輯/執行能力，與 Miyago 用 Copilot 接 Claude 的初衷相違。
- 本版 (v3)：保留 V2 session（吃 Max 訂閱）、保留 agent loop 能力、用「bridge cwd 必須是要動的 project root」的操作慣例取代 client-side execution。VSCode file watcher 會 auto-detect file change 顯示 diff，user 自己看 git diff 把關。
- 真正 client-side execution（model 動 IDE workspace、IDE 提供 review UI）需要繞過 SDK 打 Anthropic Messages API，違反「走 claude-agent-sdk 吃訂閱額度」原則。

**操作慣例**:
- 在想動的 project root 起 server：`cd ~/Project/foo && claude-sdk --ollama`
- 多 project 場景要起多個 bridge instance（不同 port），或 user 自己 toggle `claude-sdk` 來回切

**Trade-off**:
- 不 advertise `tools` 讓 Agent mode picker 隱藏 Claude，user 在 Copilot 中只能從 Chat mode 用（這是預期 — Agent mode 期待 client tool exec，我們做不到）。
- Chat mode 下 model 仍會動 file（agent loop 在 server-side 跑完），user 看到 narrative 而不是 inline diff review，需自己 `git diff` 把關。

**Status**: accepted (2026-04-29 修正 v3)

### ADR-4：Thinking 預設吃掉，request 帶 `think: true` 才 forward

**Decision**: SDK 串裡的 `thinking` content block，預設不 forward。Request body 若帶 `think: true`，把 thinking 內容包成 Ollama 的 `message.thinking` 欄位推出去。

**Rationale**:
- Copilot 目前沒在 UI 顯示 thinking，多送只是浪費頻寬。
- 預留 `think: true` 通道讓未來 Copilot/其他 client 啟用時不用改 server。

**Status**: accepted

### ADR-5：Model 命名 expose `claude-*` 原名，不偽裝成 llama

**Decision**: `/api/tags` 與 `/api/show` 回傳的 model `name` 直接用 Claude 原始 ID（`claude-opus-4-7`、`claude-sonnet-4-6`、`claude-haiku-4-5` 等），`details.family` 設為 `"claude"`。

**Rationale**:
- Copilot model picker 顯示的就是這個 name，使用者選的時候要知道自己在用 Claude。
- 偽裝成 `llama3.2` 之類的會讓 telemetry/log 看起來像在用 Llama，干擾除錯。

**Capabilities advertise**:
- `["completion", "tools", "thinking"]` — 確保 Copilot Agent 模式可選

**Status**: accepted

### ADR-6：移除 OpenAI adapter，把核心邏輯抽到 `src/shared/`

**Decision**: 整個 `src/openai/` sub-module 從 repo 拿掉（`./openai` export、`--serve` flag、README 章節、`docs/specs/openai-cli-layers/` 標記為 superseded）。原本 `transform.ts` 裡的 prompt builder / SDK assistant block 萃取邏輯抽到 `src/shared/messages.ts`，給 Ollama 用，未來要加其他 protocol 也接這層。

**Rationale**:
- Miyago 確認 OpenAI adapter 沒人在用（Copilot 走 Ollama provider 路徑、其他 OpenAI 兼容工具的需求消失）。留著等於維護成本但沒收益。
- 共用層直接以 generic history message 為輸入型別，不再耦合 OpenAI 的 wire format（tool args 是 string 而非 object 之類的怪味就跟著消失）。
- Streaming chunk 序列化（NDJSON）寫在 `src/ollama/` 內部，不放共用層 — 形狀跟未來 protocol 差太多，硬抽會過度抽象。

**Trade-off**:
- 將來若有人要 OpenAI 兼容 endpoint，要從共用層重組（但純函式都還在，重建成本不高）。
- `package.json` major-ish 變更（`./openai` export 消失），1.5.0 → 1.6.0 並在 README/CHANGELOG 標明。

**Status**: accepted

## Alternatives

| 方案 | 為何不採用 |
| --- | --- |
| 走 Ollama 內建 OpenAI compat 路徑 | Copilot 的 Ollama provider 打原生 endpoint，不會自動切 compat 模式。 |
| 保留 OpenAI adapter 並在它旁邊加 Ollama | 兩層 adapter 維護成本翻倍，OpenAI 那條已無用戶，留著就是 dead code。 |
| Stateless（每 request 開新 session） | IDE 長對話 cache miss 成本太高。 |
| Pool key 用 server-side 內部歷史 hash | Client 看不到 server 跑了哪些 tool，hash 會永遠 miss。 |
| Tool 純 client-side execution | V2 session 不支援 inject 歷史 tool_result，做不到。 |
| 偽裝成 `llama3.2:latest` 騙 picker | 干擾 telemetry，沒實際好處。 |

## Rabbit Holes

- **Tool args streaming**：Claude 把 `tool_use.input` 拆成 `input_json_delta`* fragment 流出，Ollama 規格是「整個 object 一次給」。需要在 server 累積到 `content_block_stop` 才 emit 該 frame，期間先 buffer 不發。
- **`done_reason` 對應**：Claude `end_turn`/`stop_sequence` → `stop`；`tool_use` → `stop`（Ollama 沒有 `tool_calls` reason，靠 `message.tool_calls` 是否非空判斷）；`max_tokens` → `length`（Ollama 沒這個值，但 Copilot 會看，先用 `stop` 帶過再評估）。
- **`keep_alive`**：Ollama 的 model unload timer。Bridge 不用真的 unload，但 Copilot 可能會傳 `keep_alive: 0` 試圖釋放 — 我們收到 `keep_alive: 0` 時主動 evict 對應 session。
- **`/api/version` 假裝什麼版本**：回 `{"version": "0.5.7-claude-bridge"}` 之類。Copilot 可能用版本號判斷 capability，遇到行為差異再調。
- **Auth**：MVP 不做。listen `127.0.0.1:11434`（Ollama 預設 port，Copilot 預設打這個）。Port 衝突就 fallback `41434`。
- **Image input**：Ollama messages 的 `images` 欄位（raw base64 array）已支援。`shared/messages.ts` 的 `buildPromptFromHistory` 把最後一條 user 的 images 收進 `attachments[]`，server 把它們轉成 Anthropic 的 `ImageBlockParam`（`{type:'image', source:{type:'base64', media_type, data}}`）排在 prompt text 之前一起送。Media type 由 base64 magic bytes 偵測（PNG/JPEG/GIF/WebP，default PNG，符合 VS Code Copilot screenshot 來源）。中間 user 訊息的 images 用 `[image attachment N omitted from transcript]` placeholder 表示（transcript 是純文字 flatten，無法 inline 多張圖的 byte payload；Copilot stateless 每輪都重發最後一張，不影響）。

## Out of Scope

- `/api/generate`（純 completion，不是 chat）— Copilot 用不到
- `/api/embeddings` — Copilot 不會打 Ollama 拿 embedding，inline completion 走別的路
- `/api/pull`、`/api/push`、`/api/copy`、`/api/delete` — 我們不是真的 model registry
- `/api/create`、`/api/blobs/*` — 同上
- PDF / audio / video 等非 image 多模態輸入（Anthropic 支援 PDF document block，但 Ollama 協定沒對應欄位）
- Multi-user / API key / 速率限制
- Persistent session（重開 process 後還能命中 cache）— 留給 V2 再說

## 實作概要

### Phase 1：Skeleton + non-streaming + 移除 OpenAI（最小可跑）

範圍：
- `src/shared/messages.ts` — generic history message → prompt flatten + SDK assistant block extractor（純函式、不依賴任何 wire format）
- `src/ollama/types.ts` — Ollama 原生 wire format 型別
- `src/ollama/transform.ts` — Ollama 專屬 SDK ↔ wire format 轉換（uses shared）
- `src/ollama/server.ts` — Hono server，先實 `/api/version`、`/api/tags`、`/api/show`、non-streaming `/api/chat`
- `src/ollama/index.ts` — exports
- 移除：`src/openai/` 整個目錄、`./openai` export、`--serve` flag dispatch、README OpenAI 章節
- CLI：`--serve` 重命名為 `--ollama`（mode 從 `'serve'` → `'ollama'`），help text 改寫

驗收：
- `curl http://127.0.0.1:11434/api/tags` 回 model 列表
- `curl http://127.0.0.1:11434/api/show -d '{"model":"claude-sonnet-4-6"}'` 回 capabilities
- `curl http://127.0.0.1:11434/api/chat -d '{"model":"...","messages":[...],"stream":false}'` 回完整 response
- `bun test` 全綠（OpenAI test 已隨檔案移除，新增 shared + ollama test）

### Phase 2：NDJSON streaming + session pool

範圍：
- `src/ollama/streaming.ts` — NDJSON frame 序列化、流末尾 `done: true` 帶 usage
- `src/ollama/session-pool.ts` — LRU + client-history hash + idle TTL + cleanup hook
- 整合進 `src/ollama/server.ts`

驗收：
- `curl --no-buffer ... -d '{"stream":true}'` 看得到一行行 NDJSON，最後一行 `done: true`
- 連發兩次同 prefix 對話，第二次 `prompt_eval_count` 應該大幅下降（cache hit）
- Process SIGTERM 時 session 全部 close 乾淨

### Phase 3：Tool calling + thinking forwarding

範圍：
- `src/ollama/transform.ts` 加 SDK tool_use → Ollama `message.tool_calls` mapping
- `src/ollama/server.ts` 處理 request `tools` 欄位（advertise 用，忽略內容）與 `think` 欄位
- `/api/show` capabilities 加 `tools`、`thinking`

驗收：
- Copilot 打 `/api/show` 拿到 `tools` capability
- Streaming 時 SDK 跑 Read/Bash 會看到 `message.tool_calls` frame 推出
- `think: true` request 看到 `message.thinking` frame

### Phase 4：CLI 整合 + Copilot 實測

範圍：
- `src/cli/args.ts` 加 `--ollama` flag（預設 port 11434）
- `src/cli/bin.ts` dispatch `serve --ollama`
- README 加 Ollama bridge + Copilot 設定步驟

驗收：
- `claude-sdk serve --ollama` 起得來
- VS Code Copilot Chat → Manage Models → Ollama → 看得到 `claude-*` 系列
- 選 `claude-sonnet-4-6`，跑一輪 chat / 一輪 agent（含 tool call）

## 測試方針

- **Unit tests**:
  - `src/ollama/transform.test.ts` — SDK message → Ollama frame 轉換
  - `src/ollama/streaming.test.ts` — NDJSON 序列化、tool_use buffer 累積
  - `src/ollama/session-pool.test.ts` — hash 命中/miss/branch、LRU evict、TTL
  - `src/shared/messages.test.ts` — 抽共用後既有 OpenAI 行為不變
- **Integration tests**:
  - `src/ollama/server.test.ts` — 用 `app.fetch` 模擬 HTTP，跑完整 `/api/chat` 走一遍（mock SDK session）
- **E2E**:
  - 手動：VS Code Copilot Chat 接上去跑一輪
  - 手動：Copilot Agent 模式跑一個會用 tool 的 prompt

## 風險與緩解

| 風險 | 嚴重度 | 機率 | 緩解方案 |
| ---- | ------ | ---- | -------- |
| Copilot 對 Ollama 協定的細節跟 doc 不一致（field 名/必填性） | 中 | 高 | Phase 1 完成就接 Copilot 抓 request，動態調整。打開 server 端 access log + body dump 模式。 |
| Session pool 在 streaming 中斷時狀態不一致 | 中 | 中 | client disconnect handler 主動 evict 受影響 session；下次 request 開新 session replay。 |
| Port 11434 已被真的 Ollama 佔用 | 低 | 中 | 啟動時偵測佔用，fallback 41434 並印警告；CLI 提供 `--port` override。 |
| V2 session 在長 idle 後 child process 被 OS 殺掉 | 中 | 低 | session pool 拿 session 前 health check（一個輕量 noop send 或 `peek` 之類）；失敗就 evict 重開。 |
| Tool args object 累積失敗（input_json_delta 拼不回完整 JSON） | 高 | 低 | 用既有的 SDK content block accumulator（同 `extractAssistantContent` 邏輯），不要自己 parse；fallback 是直接拿 `tool_use.input`（已是 parsed object）。 |
| Capabilities 字串拼錯讓 Copilot 不顯示 model | 中 | 中 | 第一次接通就抓 Copilot 端的 model picker 行為，記錄到 lessons.md。 |

## 對應任務

任務追蹤位於 `PROGRESS.md` 的 `## ollama-bridge` 區段。

## 變更記錄

| 日期 | 變更內容 | 變更者 |
| ---- | -------- | ------ |
| 2026-04-29 | 初版 draft | miyago |
| 2026-04-29 | ADR-6 改為「移除 OpenAI adapter」、Phase 1 範圍加上 OpenAI 拆除步驟 | miyago |
| 2026-04-29 | 加 vision 支援（capabilities 加 `vision`、shared/messages 加 attachments、server 組 ImageBlockParam）；對應 Out of Scope 與 Rabbit Holes 同步更新 | miyago |
| 2026-04-29 | ADR-1 大改：實測 Copilot OllamaProvider chat 走 `/v1/chat/completions`，bridge 改 hybrid 雙協定（discovery=原生、chat=OpenAI SSE）；新增 `src/ollama/openai-compat.ts` | miyago |
| 2026-04-29 | ADR-3 大改：拿掉 `tools` capability，純 chat 模式（vision + thinking 保留）。原因：V2 session 內建 tool 動 bridge cwd 不是 IDE workspace；客戶 tool 透傳要繞過 SDK，違反 Max 訂閱限制。maxTurns 從 10 降 1，CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 從 5 拉到 95（避免 thrashing） | miyago |
| 2026-04-29 | ADR-3 v3：恢復 agent loop（maxTurns 10、allowedTools 不限），但 capability 仍不 advertise `tools` + transport drop tool_calls。Trade-off 改為「動 bridge cwd（不是 IDE workspace）」的操作慣例 — user 在要動的 project root 起 server | miyago |
| 2026-04-29 | ADR-3 v4：advertise `tools` capability 讓 model 出現在 Copilot Agent picker（user 想用 Agent mode + bypass permission），但仍 drop tool_calls 在 transport — Agent UI 的 inline tool review surface 會空著（無 tool_calls 可 review），對話流仍跑 server-side agent loop | miyago |
