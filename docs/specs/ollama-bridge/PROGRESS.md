# Progress — ollama-bridge

> Phase 級追蹤。Batch 級 checkbox 在 `TASKS.md`。

## Phases

- [x] Phase 1：Skeleton + non-streaming + 移除 OpenAI adapter
- [ ] Phase 2：NDJSON streaming + session pool
- [ ] Phase 3：Tool calling + thinking forwarding
- [ ] Phase 4：CLI integration + Copilot E2E（CLI 已順便做掉，剩實機 E2E）

## Status

**Current**: Phase 1 完成。`bun test` 74/74 全綠，`/api/version` `/api/tags` `/api/show` 已 smoke test 過；non-streaming `/api/chat` 路徑寫好但需要實際 V2 session 才能跑通，等 Miyago 起 server 自己驗。Phase 2（streaming + session pool）等 Phase 1 確認接得上 Copilot 後再開。

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

## Notes

- VS Code Copilot 對 Ollama 協定的實際行為，doc 沒寫死，Phase 1 完成就要實測。
- Port 預設 11434（跟真 Ollama 同一個），跟既有 Ollama 安裝會衝突 → 提供 `--port` override。
