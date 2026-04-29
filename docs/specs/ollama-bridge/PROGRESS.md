# Progress — ollama-bridge

> Phase 級追蹤。Batch 級 checkbox 在 `TASKS.md`。

## Phases

- [x] Phase 1：Skeleton + non-streaming + 移除 OpenAI adapter
- [x] Phase 2：SSE streaming（`/v1/chat/completions`）+ session pool by client-history hash
- [x] Phase 3：~~Tool calling forwarding~~（重新定位：transport drop tool_use，server-side 跑 agent loop 動 bridge cwd；vision + thinking 已透傳）
- [x] Phase 4：CLI integration（`--ollama` flag）+ Copilot E2E（reload window 後 picker 顯示 Claude，chat / agent mode 都可用）

## Status

**Current**: 全 Phase 完成。140 test pass。
- Discovery 走 Ollama 原生（`/api/{tags,show,version}`）
- Chat 走 OpenAI compat（`/v1/chat/completions` SSE）
- Capabilities advertise `tools, thinking, vision`，但 transport drop tool_calls（Agent UI 無 inline review，但能進）
- Session pool by client-history prefix hash（max 50 / TTL 30min / SIGINT closeAll）
- V2 session agent loop 在 bridge cwd 跑 SDK 內建 tool（Read/Write/Bash/Edit/Glob/Grep）
- Vision: base64 → Anthropic ImageBlockParam，magic-byte media type detect

**操作慣例**: 在要動的 project root 起 `claude-sdk --ollama`；VSCode 開同 project 用 Copilot Chat / Agent。

**已知限制**:
- 看不到 inline diff review（要靠 git diff），Copilot Agent 的 tool review surface 空著
- Bridge cwd ≠ IDE workspace（沒辦法跨 project；多 project 要起多個 instance）

**Blockers**: 無。

## Decisions Log

- 2026-04-29 — 確認協定走 Ollama 原生 NDJSON（不走 OpenAI compat）
- 2026-04-29 — Tool calling 走 Ollama tools 欄位透傳（server-side 執行 + client 可見）
- 2026-04-29 — Session pool 採 client-history hash 命中（複雜方案）
- 2026-04-29 — `src/openai/` 整個移除；核心邏輯抽到 `src/shared/messages.ts`
- 2026-04-29 — Phase 1 直接做掉 `--ollama` CLI flag 與 `serveOllamaBridge`（原本 Phase 4），因為 dispatch 點正好就在重構範圍裡
- 2026-04-29 — 加 Vision 支援（shared/messages 多回 `attachments`、server 組 Anthropic ImageBlockParam）；起因是 Copilot 連上後發現 vision 蠻常用
- 2026-04-29 — Lesson: Copilot Ollama provider 對 server version 有 floor（>= 0.6.4），BRIDGE_VERSION 改 0.10.0 純 semver
- 2026-04-29 — Lesson: Copilot UI capability 顯示靠 in-memory `_modelCache`，重啟 server 不夠，要 reload window 或重 add provider
- 2026-04-29 — **架構修正**：Copilot OllamaProvider chat 走 OpenAI compat (`/v1/chat/completions`)，不是 Ollama 原生 `/api/chat`。Bridge 改 hybrid 雙協定。從 git afc1537 復活 OpenAI adapter 的 SSE converter / non-stream builder 進 `src/ollama/openai-compat.ts`
- 2026-04-29 — Phase 2 完成：session pool by client-history prefix hash（LRU max 50, idle TTL 30min, SIGINT closeAll）。命中時只 send last user message + reuse 既有 V2 session，cold start + cache 紅利兩個一起拿

## Notes

- VS Code Copilot 對 Ollama 協定的實際行為，doc 沒寫死，Phase 1 完成就要實測。
- Port 預設 11434（跟真 Ollama 同一個），跟既有 Ollama 安裝會衝突 → 提供 `--port` override。
