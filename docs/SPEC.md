# @lovely-office/sdk -- 規格文件

> 從 `@anthropic-ai/claude-agent-sdk` v0.2.77 fork，加上 5 個 token 優化 patch。

## 概述

把 Claude Max 訂閱變成可輪詢的 AI 後端，用於多 agent 協作迴圈。
與官方 SDK 完全相容（drop-in replacement），額外加入 5 個精準 patch 減少 token 浪費。

## 架構

```text
Lovely Office Process (Bun)
  |
  +-- Lobster (agent 實例)
  |     |
  |     +-- query({ prompt, options })  <-- SDK 進入點
  |           |
  |           +-- cli.js (53 萬行，已 patch)
  |                 |
  |                 +-- Claude Code 內建 agent loop
  |                 +-- 內建 tools: Read, Write, Edit, Bash, Glob, Grep, Agent
  |                 +-- Session 持久化（透過 sessionId 恢復對話）
  |                 +-- Prompt cache（patch #4 啟用）
  |
  +-- Discord Bot（訊息路由）
  +-- Webhook（每個 agent 各自的身份）
```

## 核心 API

### `query(params): AsyncGenerator<SDKMessage>`

主要進入點。送出 prompt 給 Claude，以 async generator 串流回傳訊息。

```typescript
import { query } from '@lovely-office/sdk'

const q = query({
  prompt: 'Hello',
  options: {
    model: 'claude-opus-4-6',
    maxTurns: 20,
    maxBudgetUsd: 1.0,
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: true,
    allowedTools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Write', 'Edit', 'Bash'],
    effort: 'high',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: '你的自訂指令',
    },
    resume: 'session-uuid',  // 選填：恢復上一次對話
  },
})

for await (const msg of q) {
  if (msg.type === 'assistant') {
    // text blocks + tool_use blocks
  } else if (msg.type === 'result') {
    // 最終結果: session_id, num_turns, total_cost_usd, is_error
  }
}
```

### 主要 Options

- `model` (string) -- `'claude-opus-4-6'`、`'claude-sonnet-4-6'`、`'claude-haiku-4-5-20251001'`
- `maxTurns` (number) -- 每次互動最多幾輪 tool use
- `maxBudgetUsd` (number) -- 花費超過此金額就停止
- `allowedTools` (string[]) -- 白名單：agent 可以使用的 tools
- `disallowedTools` (string[]) -- 黑名單（優先於白名單，硬限制）
- `permissionMode` (PermissionMode) -- 無人值守用 `'bypassPermissions'`
- `persistSession` (boolean) -- 將對話存到磁碟，下次可 resume
- `resume` (string) -- 要恢復的 session UUID
- `effort` (string) -- `'low'` / `'medium'` / `'high'` -- 推理深度
- `systemPrompt` (string 或 object) -- 自訂 prompt 或用 `claude_code` preset + append
- `cwd` (string) -- 檔案 tools 的工作目錄

### 權限模式

- `'default'` -- 危險操作會提示使用者確認
- `'acceptEdits'` -- 自動同意檔案編輯
- `'bypassPermissions'` -- 跳過所有檢查（需要 `allowDangerouslySkipPermissions: true`）
- `'plan'` -- 只規劃、不執行 tool
- `'dontAsk'` -- 未預先授權就拒絕，不提示

### 訊息型別（串流回傳）

- `'assistant'` -- 模型回應，包含 text block 和 tool_use block
- `'result'` -- 最終摘要：session_id、num_turns、total_cost_usd
- `'system'` -- 系統事件：api_retry、hook_error 等
- `'partial_assistant'` -- 串流 chunk（需設 `includePartialMessages: true`）

### Query 操作方法

- `q.interrupt()` -- 立即中斷處理
- `q.setModel(model)` -- 中途切換模型
- `q.sendMessage(msg)` -- 在處理中注入額外訊息
- `q.rewindFiles()` -- 回滾檔案變更到上一個使用者訊息的狀態

## Exports

```typescript
import { query, tool, createSdkMcpServer } from '@lovely-office/sdk'
import cliPath from '@lovely-office/sdk/embed'           // Bun 編譯後的 binary
import { query as browserQuery } from '@lovely-office/sdk/browser'  // WebSocket 傳輸（瀏覽器用）
```

## 認證

使用 Claude Max 訂閱的 OAuth。只需認證一次：

```bash
claude login
```

之後 SDK 使用存好的 OAuth token，不需要 API key。

## 5 個 Patch 詳解

### Patch 1: Context 溢出安全邊距

- **位置**: cli.js ~第 236819 行
- **改動**: 安全邊距從 1000 tokens 降到 200 tokens
- **原因**: 官方 SDK 在觸發 context compaction 前預留 1000 tokens 的緩衝區，對 agent loop 來說太保守了。我們希望最大化可用 context window，所以縮減到 200。
- **額外**: 接近極限時發出 `tengu_context_near_full_needs_compact` 信號。

### Patch 2: 主 Fork Loop 裁剪

- **位置**: cli.js ~第 346651 行
- **改動**: fork 對話時只保留最近 5 輪
- **原因**: SDK fork 對話時（例如 subagent chain），會複製整段對話歷史。多 agent 環境下，每次 fork 都帶著越來越大的 context。裁剪到最近 5 輪可以防止 context 指數增長，同時保留足夠的上下文讓對話連貫。
- **節省**: 深層 agent chain 的 fork 啟動成本最多降 80%。

### Patch 3: Subagent Fork Context 裁剪

- **位置**: cli.js ~第 391538 行
- **改動**: subagent 繼承的 context 只保留最近 10 則訊息
- **原因**: 跟 Patch 2 類似，但針對 `Agent` tool 產生的 subagent。subagent 有自己的 system prompt 和專注任務，繼承完整的父對話是浪費。10 則訊息提供足夠上下文但不帶完整歷史。
- **節省**: subagent 冷啟動成本降 ~60%。

### Patch 4: SDK 啟用 Prompt Cache（影響最大）

- **位置**: cli.js ~第 455180 行
- **改動**: 讓 `sdk` querySource 也能使用 prompt cache（官方只開放給 `repl_main_thread`）
- **原因**: 官方 SDK 只對互動式 CLI（REPL）啟用 prompt caching。但我們的 agent 重複呼叫時帶的 system prompt 都一樣，這正是 prompt cache 最理想的使用場景。
- **效果**: system prompt（通常 2000+ tokens）在第一次呼叫後被 cache。後續同一個 agent 的呼叫只需送差異部分，不用重送整個 prompt。**這是節省最多的 patch。**

### Patch 5: Streaming 失敗不重試

- **位置**: cli.js ~第 455529 行
- **改動**: 如果已經收到 content block，就跳過 non-streaming 重試
- **原因**: 串流回應中途失敗時，官方 SDK 會用 non-streaming 模式重試整個請求。但如果我們已經收到部分 content（tool call、text），重試等於把同樣的 token 送兩次。這個 patch 在已有部分內容時跳過重試。
- **節省**: 避免串流失敗時 ~100% 的 token 浪費。

## 從官方 SDK 更新

```bash
# 1. 更新 package.json 裡的官方 SDK 版本
# 2. 跑 patch 腳本：
bash packages/sdk/scripts/patch.sh

# 3. 腳本會 beautify cli.js，然後手動重新套用 patch
# 4. 測試：bun test packages/sdk/
```

## 設計決策

### 為什麼 fork 而不是 monkey-patch？

這些 patch 修改的是內部控制流（fork 裁剪、cache 開關），不是透過 SDK options 暴露的介面。Runtime monkey-patch 在版本更新時很脆弱。釘死版本的 fork + 清楚文件化的 patch 更好維護。

### 為什麼用 Claude Max 而不是 API？

Lovely Office 同時跑 7 個 agent，每個每分鐘可能多次 SDK 呼叫。用 API 計費會破產。Claude Max 提供月費吃到飽 + 寬鬆的 rate limit，適合 always-on 的 agent 團隊。

### 為什麼用 `bypassPermissions`？

Agent 無人值守運行（沒有人在迴圈裡按確認）。權限控制在更上層透過 `allowedTools` / `disallowedTools` 實現 -- 每個 agent 只拿到符合角色的 tools（PM 只能 Read，開發者有 Read/Write/Edit/Bash 等）。

## 檔案結構

```text
packages/sdk/
  src/
    cli.js              # 53 萬行 -- beautify + patch 後的 Claude Code binary
    sdk.mjs             # 65 行 -- re-export query/tool/createSdkMcpServer
    sdk.d.ts            # 3607 行 -- 完整 TypeScript 型別定義
    sdk-tools.d.ts      # Tool 型別定義
    index.ts            # 進入點（re-export sdk.mjs）
    embed.js            # Bun binary embed 路徑
    browser-sdk.js      # WebSocket 傳輸（瀏覽器用）
  scripts/
    patch.sh            # Beautify + 準備 patching
  package.json          # version 0.2.0, exports map
  README.md             # 快速參考（英文）
  SPEC.md               # 本文件
```
