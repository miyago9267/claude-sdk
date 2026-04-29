# Tasks — ollama-bridge

> 當前 batch 的實作步驟。Phase 級追蹤在 `PROGRESS.md`。

## Phase 1: Skeleton + non-streaming + 移除 OpenAI

- [x] `src/shared/messages.ts` — 共用層：`buildPromptFromHistory` (history → prompt + system) + `extractAssistantBlocks` (SDK assistant content → text + tool_use[])，純函式不依賴 wire format
- [x] `src/shared/messages.test.ts` — 共用層 unit test
- [x] `src/ollama/types.ts` — Ollama wire format 型別（OllamaChatRequest, OllamaChatFrame, OllamaTagsResponse, OllamaShowRequest/Response, OllamaVersionResponse）
- [x] `src/ollama/transform.ts` — SDK ↔ Ollama 純函式（ollamaMessagesToHistory, buildShowResponse, buildTagsResponse, mapDoneReason, buildAssistantFrame）
- [x] `src/ollama/transform.test.ts` — transform unit test
- [x] `src/ollama/server.ts` — Hono server: `/api/version`, `/api/tags`, `/api/show`, non-streaming `/api/chat`
- [x] `src/ollama/server.test.ts` — 用 `app.fetch` mock 跑 endpoint
- [x] `src/ollama/index.ts` — exports (`createOllamaServer`, `serveOllamaBridge`, types)
- [x] 移除 `src/openai/` 整個目錄
- [x] `src/cli/args.ts` — `--serve` 改 `--ollama`，mode `'serve'` → `'ollama'`，help text rewrite
- [x] `src/cli/args.test.ts` — `--ollama` flag test
- [x] `src/cli/bin.ts` — dispatch `mode === 'ollama'` → `serveOllamaBridge`
- [x] `package.json` — 拿掉 `./openai` export，加 `./ollama` + `./shared`，`files` 列表更新，`description`/`keywords` 改寫，version 1.5.0 → 1.6.0，`scripts.serve` → `scripts.ollama`
- [x] `README.md` — 拿掉 OpenAI Adapter 章節，加 Ollama Bridge 章節（含 VS Code Copilot Manage Models 設定步驟）
- [x] `bun test` 全綠（74 tests pass / 0 fail）
- [ ] 手動 E2E：VS Code Copilot Manage Models → Ollama 看到 `claude-*` 系列、跑一輪 chat（需 Miyago 實機驗證）

## Phase 2: NDJSON streaming + session pool

- [ ] `src/ollama/streaming.ts` — NDJSON serialiser、tool_use buffer accumulator、最後 frame 帶 usage
- [ ] `src/ollama/streaming.test.ts` — buffer 累積、frame 邊界、abort 中斷
- [ ] `src/ollama/session-pool.ts` — LRU + client-history hash + idle TTL + cleanup hook (SIGINT/SIGTERM)
- [ ] `src/ollama/session-pool.test.ts` — hash 命中/branch/evict/TTL
- [x] `src/ollama/server.ts` — 整合 streaming 與 pool
- [x] `src/ollama/server.test.ts` — 加 streaming 端測試

## Phase 3: Tool calling + thinking

- [x] `src/ollama/transform.ts` — SDK tool_use → Ollama `message.tool_calls`、SDK thinking → `message.thinking`
- [x] `src/ollama/server.ts` — request `tools` 探測、`think` flag
- [x] `src/ollama/server.ts` — `/api/show` capabilities 加 `tools`、`thinking`
- [ ] test: tool_use 累積完整 args object、thinking forward 開關

## Phase 4: CLI + 實測

- [ ] `src/cli/args.ts` — `--ollama`, `--port`, `--host` flag
- [ ] `src/cli/args.test.ts` — flag parsing
- [ ] `src/cli/bin.ts` — dispatch `serve --ollama` → `serveOllamaBridge`
- [ ] `package.json` — version bump 到 1.6.0，`exports./ollama`
- [ ] `README.md` — Ollama bridge 章節 + VS Code Copilot 設定步驟（Manage Models → Ollama → 指向 `http://127.0.0.1:11434`）
- [ ] 手動 E2E：Copilot Chat 跑一輪
- [ ] 手動 E2E：Copilot Agent 跑一輪（含 tool call）
- [ ] `bun test` 全綠
