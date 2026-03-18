# SDK Reverse Engineering v0.2.76 — Token Consumption & V2 Persistent Session

**調查日期：** 2026-03-14 ~ 2026-03-15
**SDK 版本：** `@anthropic-ai/claude-agent-sdk` v0.2.76（對應 Claude Code v2.1.76）
**前置研究：** `system-reminder-調查報告.md`, `system-reminder-工程筆記.md`
**錨點索引：** `sdk-anchor-index-v76.md`

---

## 一、問題陳述

| 場景 | 每次訊息消耗（5hr 額度） | 行為 |
|---|---|---|
| Claude Code CLI resume → 第一個訊息 | 2-3% | 還沒回應就已消耗 |
| Claude Code CLI resume → 第二個訊息起 | <1% | 幾乎觀察不到 |
| Agent SDK resume → **每一個訊息** | 2-3% | 每次都像 CLI 的「第一個訊息」 |

ClaudeCab 使用 Agent SDK 進行所有 agent 對話，每次互動成本是 CLI 的數倍，嚴重影響運營可行性。

---

## 二、v0.2.76 完整流程全貌

以下是 Agent SDK 發送一則訊息時的**端到端流程**，從你的 TypeScript 程式碼呼叫 `query()` 開始，到 Anthropic API 回傳為止。理解這個流程是理解成本問題的關鍵。

### 階段 A：SDK 層（sdk.mjs）

```
你的程式碼呼叫：
  query({ prompt: "hello", options: { resume: "session-uuid-xxx" } })

sdk.mjs 內部（Yh 函數）：
  1. 設定環境變數 CLAUDE_AGENT_SDK_VERSION
  2. 建立 y9（ProcessTransport）實例
  3. y9.initialize() 執行：
     child_process.spawn("node", [
       "cli.js",
       "--output-format", "stream-json",
       "--verbose",
       "--input-format", "stream-json",
       "--model", "claude-opus-4-6",
       "--setting-sources", "project,local",    ← 會載入 CLAUDE.md
       "--resume", "session-uuid-xxx",           ← 從 JSONL 重建對話
       "--permission-mode", "default",
       "--permission-prompt-tool", "stdio",
     ])
  4. 建立 h9（Query）實例，透過 stdin 發送 initialize control_request
  5. 透過 stdin 發送 user message JSON
  6. stdin.end() → 告訴 CLI「沒有更多輸入了」
  7. 開始從 stdout 讀取回應 JSON stream
```

**關鍵：每次 `query()` 都 spawn 一個全新的 node process。** V1 API 不複用 process。

### 階段 B：cli.js 引擎層 — Session Resume 與狀態重建

> **重要釐清：** `cli.js` 是 Claude Code 的核心引擎（12MB），打包在 `node_modules/@anthropic-ai/claude-agent-sdk/cli.js`。
> 它跟你在終端機打 `claude` 用的是**同一份引擎**。Agent SDK 的 `sdk.mjs` 只是一個薄 wrapper（65 行），
> 透過 `child_process.spawn("node", ["cli.js", ...])` 把所有工作委派給這個引擎。
> 因此，以下「cli.js 引擎層」的描述**同時適用於 SDK 呼叫和 CLI 互動模式**，
> 差別只在 process 的生命週期：SDK 每次新建、CLI 互動模式持續存活。

新的 cli.js process 啟動後：

```
步驟 B1：載入 JSONL 對話歷史
  路徑：~/.claude/projects/{projectHash}/{sessionId}.jsonl
  函數：MT7() / Ua()
  結果：得到完整的 messages 陣列（所有歷史 user/assistant 訊息）

步驟 B2：重建 readFileState（C26/kKA 函數）
  掃描 JSONL 中的 assistant messages，找 Read/Write tool_use
  建立 LRU Cache（max=10），每個 entry：
    { path, content, timestamp: JSONL訊息時間戳, offset: undefined }
  ⚠️ timestamp 是「過去的時間」
  ⚠️ offset 全部 undefined → 全部會被 stale check 追蹤
  ⚠️ 我們的 JsonlSanitizer 在此步驟前修改 JSONL，
     讓 Read 的 offset=1、Write 無 content → C26 收集不到 → readFileState 為空

步驟 B3：載入設定
  讀取 .claude/settings.local.json（agent 權限）
  讀取 CLAUDE.md（專案指令，從 cwd 往上搜尋）
  讀取 MEMORY.md（auto memory）
  讀取所有 memory files
```

### 階段 C：cli.js 引擎層 — Runtime System-Reminder 注入

**這是造成 cache bust 的核心階段。** 在組裝 API request 前，CLI 動態產生一系列 `<system-reminder>` 並注入到 messages 陣列中。這些注入**不存在 JSONL**，是每次 runtime 重新產生的。

```
步驟 C1：claudeMd + currentDate 注入（eE1 函數）
  在 messages 陣列的【第一個位置】插入：
  {
    role: "user",
    content: "<system-reminder>
      As you answer the user's questions...
      # claudeMd
      [CLAUDE.md 全文]
      [MEMORY.md 全文]
      # currentDate
      Today's date is 2026-03-15.
      IMPORTANT: this context may or may not be relevant...
    </system-reminder>",
    isMeta: true    ← UI 不顯示
  }
  📍 這是 messages 的第一個 content → 如果內容有任何變化，
     從此處之後的所有 messages 的 cache prefix 全部失效

步驟 C2：gitStatus 注入（sf8 → mw 函數）
  執行 git status 取得工作區狀態
  注入到 messages 前段作為 system_context
  ⚠️ 每次 git status 結果可能不同（檔案修改、stage 變化）
  ⚠️ CLAUDE_CODE_REMOTE=1 可跳過此注入

步驟 C3：readFileState stale check（CuY/jqY 函數）
  遍歷 readFileState 的每個 entry：
    if (file.mtime > entry.timestamp) {
      注入: "<system-reminder>Note: {file} was modified...{diff}</system-reminder>"
    }
  ⚠️ C26 重建的 timestamp 是過去時間 → 幾乎必定觸發
  ⚠️ 我們的 JsonlSanitizer 讓 C26 收集不到 → 不觸發

步驟 C4：其他動態注入
  - nested_memory：memory 檔案 + mtime 時間戳
  - task_reminder：目前的 TaskCreate/TaskUpdate 任務列表
  - todo_reminder：目前的 TodoWrite 項目列表
  - invoked_skills：可用 skills 列表（~2000+ tokens）
  - diagnostics：LSP 回報的錯誤/警告
  - hook outputs：hook 執行結果
  - 等 30+ 種類型，見第三節完整列表
```

**關鍵：步驟 C1-C4 的輸出在兩次不同的 CLI process 間無法保證 byte-for-byte 相同。** 即使「語義上相同」（同一天、同樣的 CLAUDE.md），序列化細節（memory mtime 時間戳、task 列表順序等）可能有微小差異，導致 cache prefix 不匹配。

### 階段 D：cli.js 引擎層 — API Request 組裝

完成注入後，CLI 組裝最終的 Anthropic API request：

```
步驟 D1：System Prompt 組裝（Jn8 → _9z 函數）
  system prompt 被分為多個 content block：
  [
    { type: "text", text: "[billing header]" },                    // 無 cache
    { type: "text", text: "[Claude Code 核心指令]",
      cache_control: { type: "ephemeral", scope: "global" } },    // ← 全域 cache
    { type: "text", text: "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__" },
    { type: "text", text: "[動態部分：agent 自訂 prompt]" },       // 無 cache
  ]
  📍 scope:"global" 的 block 可跨不同 session 共享 cache
  📍 DYNAMIC_BOUNDARY 之後的部分不 cache（因為可能每次不同）

步驟 D2：Tools 組裝
  所有啟用的工具 schema（Read, Write, Edit, Bash, Glob, Grep...）
  + MCP server 提供的工具
  📍 工具定義受 system prompt 最後 cache breakpoint 的 prefix 保護
  📍 如果 system prompt 沒變，工具定義自然被 cache

步驟 D3：Messages 組裝 + Cache Breakpoint（z9z 函數）
  messages = [
    {role:"user", content:"[C1 注入的 claudeMd+date]"},     ← 位置 0
    {role:"assistant", content:"[歷史回覆 1]"},
    {role:"user", content:"[歷史訊息 2 + C4 注入]"},
    ...
    {role:"assistant", content:"[歷史回覆 N-1]",
      cache_control: {type:"ephemeral"} },                   ← 倒數第 2
    {role:"user", content:"[新 user message + C3/C4 注入]",
      cache_control: {type:"ephemeral"} },                   ← 倒數第 1
  ]
  📍 只有最後 2 則 message 加 cache_control（滑動視窗策略）
  📍 cache 的 prefix match 從 system prompt 開頭算到 breakpoint

步驟 D4：發送 HTTP Request
  POST https://api.anthropic.com/v1/messages
  Headers: anthropic-beta: prompt-caching-scope-2026-01-05, ...
  Body: { model, system, tools, messages, max_tokens, metadata }
```

### 階段 E：Anthropic API — Prompt Caching 判定

```
API 收到 request 後：

1. 從 request body 的第一個 byte 開始，與 server-side cache 做 prefix match
2. 匹配到最長的 cached prefix（到某個 cache breakpoint 為止）
3. 匹配的部分 = cache READ（10% 費用）
4. 不匹配的部分 = cache WRITE（125% 費用）或一般 input（100% 費用）
5. Cache 存活 5 分鐘（預設），之後過期需重新 WRITE

以 ~61k total tokens 為例：
  system prompt（~15k tokens）：每次完全相同 → cache READ
  messages（~45k tokens）：
    位置 0 的 claudeMd 注入如果與上次不同 → 從此處起全部 cache MISS
    → 45k tokens 全部 cache WRITE（125% 費用）
```

### 階段 F：同一個 cli.js 引擎，不同的啟動方式

兩者跑的是**完全相同的 cli.js 程式碼**，差異只在 process 生命週期：

```
【CLI 互動模式 — 你在終端機打 claude，第二個訊息起】
  同一個 node process 持續運行（你不關終端就一直活著）
  → readFileState 在 process 記憶體中（不重建）
  → system-reminders 由同一個 runtime 產生（內容穩定）
  → messages 只多了 2 則新訊息，其餘完全不變
  → API prefix：system(15k) + messages(45k) = 60k cache READ（10%）
  → 只有新增的 ~1k 是 WRITE
  → 結果：每次 ~0.2% 額度

【SDK V1 query() — ClaudeCab 目前的方式，每個訊息】
  sdk.mjs 每次 spawn 新 node process 執行同一個 cli.js
  → cli.js 從零開始：讀 JSONL → 重建狀態 → 重新注入（階段 B-D 全部重跑）
  → 注入內容無法保證 byte-for-byte 相同（即使語義相同）
  → messages 的 prefix 從位置 0 就不匹配
  → API prefix：system(15k) cache READ + messages(45k) cache WRITE
  → 結果：每次 ~1-3% 額度

【SDK V2 createSession() — 我們的解法】
  sdk.mjs 只 spawn 一次 cli.js process，後續 send() 透過 stdin 在同一 process 內通訊
  → cli.js 只跑一次階段 B，之後只重複 C-D → 行為等同 CLI 互動模式
  → 預期：第一訊息 ~2%，之後每次 <1%
```

### 流程總結圖

```
                    node_modules/@anthropic-ai/claude-agent-sdk/
                    ├── sdk.mjs（薄 wrapper，65 行）
                    └── cli.js（完整引擎，12MB）← 跟終端機的 claude 指令是同一份

┌──────────────────┐      ┌─────────────────────────────────────────────┐
│ ClaudeCab 程式碼  │      │  cli.js process（Claude Code 引擎）          │
│                  │      │                                             │
│ SDKQueryManager  │      │  B1: 讀 JSONL → 重建 messages               │
│   ↓              │      │  B2: 重建 readFileState (C26)               │
│ sdk.mjs          │      │  B3: 載入 CLAUDE.md / settings               │
│   ↓              │      │  ──── 以上只在 process 啟動時跑一次 ────      │
│ spawn("node",    │      │  C1: 注入 claudeMd+date  ← ⚠️ 可能不同     │
│   ["cli.js"]) ───┼──→   │  C2: 注入 gitStatus     ← ⚠️ 可能不同     │
│                  │      │  C3: 注入 file diffs    ← ✅ sanitizer      │
│ V1: 每次新 spawn │      │  C4: 注入 tasks/memory  ← ⚠️ 可能不同     │
│ V2: 只 spawn 一次│      │  D1-D4: 組裝 API request                     │
│                  │      │         system(15k) + tools + messages(45k)  │
└──────────────────┘      └──────────────┬──────────────────────────────┘
                                         │
                          ┌──────────────▼──────────────────────┐
                          │    Anthropic API                     │
                          │                                      │
                          │  server-side prompt cache 判定：      │
                          │    system(15k) → ✅ cache READ       │
                          │    messages(45k) → ❌ cache WRITE    │
                          │    (C1-C4 每次產生的內容有微小差異     │
                          │     → prefix 從 C1 注入點起不匹配)   │
                          │                                      │
                          │  V1 結果: cache efficiency ~25%      │
                          │  V2 預期: cache efficiency ~95%+     │
                          └──────────────────────────────────────┘
```

---

## 三、Cache Bust 的所有動態注入源

以下內容在 CLI subprocess 的 **runtime 動態注入**（不存在 JSONL 中），任何變化都會導致 cache prefix mismatch。

### 3.1 高影響（跨 process 幾乎必變）

| 注入源 | 觸發函數 | 變化原因 | 已解決？ |
|---|---|---|---|
| **gitStatus** | `sf8()` → `mw()` | 每次 `git status` 結果不同 | **Phase 1: CLAUDE_CODE_REMOTE=1** |
| **readFileState diffs** | `C26()` → `jqY()` | JSONL 重建 → stale check → diff 注入 | **已解決: JsonlSanitizer** |
| **hook outputs** | hook_success/error/context | stdout/stderr 每次不同 | 部分可控 |

### 3.2 中影響（取決於使用模式）

| 注入源 | 觸發函數 | 變化原因 | 緩解方式 |
|---|---|---|---|
| **task_reminder** | todo/task 注入 | 任務列表狀態變化 | 清空任務 |
| **claudeMd content** | `eE1()` | MEMORY.md 被自動更新 | 減少 memory 更新頻率 |
| **nested_memory mtime** | `sF8()` + `Cz8()` | 記憶檔案帶有 mtime 時間戳 | 避免高頻修改 |
| **diagnostics** | LSP 回報 | 每次診斷內容不同 | headless 無 LSP |

### 3.3 低影響

| 注入源 | 觸發函數 | 變化原因 |
|---|---|---|
| **currentDate** | `GD6()` | 一天變一次 |
| **deferred_tools_delta** | MCP 工具增減 | 除非配置變化 |
| **skills listing** | 可用 skills 列表 | 除非 skill 增減 |

---

## 四、CLI 的 Cache Control 架構

### 4.1 三層 Cache Breakpoint

```
1. System Prompt
   ├─ billing header (cacheScope: null, 不快取)
   ├─ org-level prompt (cacheScope: "org", 可跨 org 快取)
   ├─ __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__
   └─ 動態部分 (cacheScope: null, 不快取)

2. Tools
   └─ 受 system prompt 最後 breakpoint 的 prefix 保護

3. Messages (z9z 函數)
   └─ 只在最後 1-2 個 message 的最後 content block 上放 cache_control:ephemeral
```

### 4.2 Cache Control 生成

```javascript
// Ml() — cache_control 建構
function Ml({scope, querySource} = {}) {
  return {
    type: "ephemeral",
    ...o3z(querySource) ? {ttl: "1h"} : {},      // Pro plan + allowlist → 1h TTL
    ...scope === "global" ? {scope: "global"} : {} // 跨 session 共用
  };
}
```

### 4.3 TTL 規則

| 條件 | TTL | Write 成本 |
|---|---|---|
| 預設 | 5 分鐘 | 125% input |
| Pro plan + OAuth + allowlist | 1 小時 | 200% input (!) |
| Bedrock + ENABLE_PROMPT_CACHING_1H_BEDROCK | 1 小時 | 200% input |

**注意：1h TTL 的 cache WRITE 成本是 200%（2x），比 5m 的 125% 更貴。** 
見 GitHub Issue [#188](https://github.com/anthropics/claude-agent-sdk-typescript/issues/188)。

---

## 五、SDK 架構分析

### 5.1 V1 API — `query()` （目前使用）

```
query({ prompt, options: { resume } })
  → spawn 新 CLI subprocess (y9 ProcessTransport)
  → CLI 載入 JSONL → 重建 conversation → 注入 system-reminders → API call
  → stdin 關閉 → process 結束
```

**每次都是新 process = 每次都需要重新建立 cache。**

### 5.2 V2 API — `unstable_v2_createSession()` （alpha）

```
createSession(options)
  → spawn CLI subprocess (y9 ProcessTransport)
  → stdin 保持開啟
  → send(message) → 同一 process 的 stdin 寫入
  → stream() → 同一 process 的 stdout 讀取
  → close() → stdin 關閉 → process 結束
```

**Process 持續存活 = cache 自然保持 = 等同 CLI 互動模式。**

### 5.3 V2 的限制（v0.2.76）

| 選項 | V1 query() | V2 createSession() |
|---|---|---|
| settingSources | 可自訂 | **硬編碼 `[]`** |
| systemPrompt | 可自訂 | **無** |
| mcpServers | 可自訂 | **硬編碼 `{}`** |
| cwd | 可自訂 | **無**（用 process.cwd()） |
| thinkingConfig | 可自訂 | **硬編碼 void 0** |
| maxTurns / maxBudgetUsd | 可自訂 | **硬編碼 void 0** |

---

## 六、緩解方案

### Phase 1：Quick Wins（已實作）

#### 1a. CLAUDE_CODE_REMOTE=1

在 `SDKQueryManager.executeQuery()` 的 sdkOptions 中加入：
```typescript
env: { CLAUDE_CODE_REMOTE: '1' }
```

效果：CLI 的 `sf8()` 函數在 `CLAUDE_CODE_REMOTE=1` 時回傳 null，跳過 `git status` 執行。
消除 gitStatus 這個最大的 cache bust 源。

**位置：** `src/core/SDKQueryManager.ts` 第 162-180 行

#### 1b. Cache 效率監控

在 query result 處理中計算 `cacheEfficiencyPct`：
```
cacheEfficiency = cacheReadInputTokens / (inputTokens + cacheReadTokens + cacheCreationTokens)
```

目標值：>80% = 良好 cache hit，<50% = cache bust 嚴重。

**位置：** `src/core/SDKQueryManager.ts` result logging

#### 1c. JSONL Sanitizer（既有）

在 resume 前預處理 JSONL，破壞 C26 readFileState 重建條件。

**位置：** `src/core/JsonlSanitizer.ts`

### Phase 2：Persistent Session（推薦路線）

#### 推薦方案：Minimal Patch cQ Constructor

Patch `sdk.mjs` 中 `cQ` class（SDKSession 實作）的 constructor，讓 V2 API 接受完整選項。

**改動量：** ~15 行 runtime + ~20 行 type definitions
**核心改動：**

```javascript
// 原始硬編碼（cQ constructor → new y9({...})）
settingSources: []
mcpServers: {}

// Patch 為
settingSources: Q.settingSources ?? []
mcpServers: Q.mcpServers ?? {}

// 原始（cQ constructor → new h9(...)）
new h9($, false, Q.canUseTool, Q.hooks, this.abortController, new Map)

// Patch 為（加入 initConfig 以支援 systemPrompt）
new h9($, false, Q.canUseTool, Q.hooks, this.abortController, new Map, void 0, 
  {systemPrompt: Q.systemPrompt, appendSystemPrompt: Q.appendSystemPrompt}, void 0)
```

**自動化：** postinstall script (`scripts/patch-sdk-v2.js`)
**維護成本：** 每次 SDK 升級 15-30 分鐘確認 patch 相容性

#### 為什麼不選 DIY Persistent Session

| 維度 | Patch cQ | DIY |
|---|---|---|
| 工作量 | 2-3h | 15-18h |
| 風險 | 低-中 | 高 |
| SDK infrastructure 複用 | 全部（h9 control protocol, MCP routing, hooks） | 無，全部重寫 |
| 維護成本/次升級 | 15-30min | 2-4h |

### Phase 3：未來展望

- 監控 Anthropic SDK 更新，V2 `SDKSessionOptions` 若補齊選項則移除 patch
- 考慮對 Anthropic 提 PR 或 issue 要求 V2 支援完整選項
- 監控 `prompt-caching-scope-2026-01-05` beta 的 global cache scope 效果

---

## 七、GitHub 社群相關 Issues

### claude-agent-sdk-typescript

| Issue | 標題 | 相關性 |
|---|---|---|
| [#188](https://github.com/anthropics/claude-agent-sdk-typescript/issues/188) | SDK defaults to 1h cache TTL (2x write cost) | 直接相關 |
| [#89](https://github.com/anthropics/claude-agent-sdk-typescript/issues/89) | Cache Control in SDK | 直接相關 |
| [#124](https://github.com/anthropics/claude-agent-sdk-typescript/issues/124) | Tool Search / defer_loading | 間接相關 |
| [#88](https://github.com/anthropics/claude-agent-sdk-typescript/issues/88) | Forking from historical messages | 間接相關 |

### anthropics/claude-code

| Issue | 標題 | 相關性 |
|---|---|---|
| [#24147](https://github.com/anthropics/claude-code/issues/24147) | Cache read tokens consume quota | 直接相關 |
| [#16856](https://github.com/anthropics/claude-code/issues/16856) | Excessive token usage 4x+ | 間接相關 |
| [#9769](https://github.com/anthropics/claude-code/issues/9769) | --no-system-reminders | 直接相關（未解決） |

### 社群文章

- [Why Claude Code Subagents Waste 50K Tokens Per Turn](https://dev.to/jungjaehoon/why-claude-code-subagents-waste-50k-tokens-per-turn-and-how-to-fix-it-41ma)
- [Anthropic Just Fixed the Biggest Hidden Cost (Automatic Prompt Caching)](https://medium.com/ai-software-engineer/anthropic-just-fixed-the-biggest-hidden-cost-in-ai-agents-using-automatic-prompt-caching-9d47c95903c5)
- [Claude Code's Hidden Cost Problem](https://www.webpronews.com/claude-codes-hidden-cost-problem-developers-sound-the-alarm-over-anthropics-opaque-token-billing/)

---

## 八、關鍵程式碼符號索引

### cli.js（v2.1.76 逆向）

| 函數 | 功能 |
|---|---|
| `sf8()` / `mw()` | git status 取得與注入 |
| `C26()` / `kKA()` | Session resume 的 readFileState 重建 |
| `jqY()` / `Xl5()` | Stale check（file modification diff 注入） |
| `eE1()` | claudeMd + currentDate 注入到 messages |
| `Ml()` / `RhA()` | cache_control 建構（ephemeral + TTL） |
| `z9z()` / `Y$7()` | Messages cache breakpoint 放置（最後 2 則） |
| `_9z()` / `J$7()` | System prompt cache breakpoint 放置 |
| `IGq()` / `BJ9()` | Caching 啟用開關 |
| `o3z()` | 1h TTL 判斷（OAuth + allowlist） |
| `Jn8()` | System prompt 分段 + cacheScope 設定 |

### sdk.mjs（v0.2.76）

| 符號 | 功能 |
|---|---|
| `Yh` / `query()` | V1 API 入口 |
| `$h` / `unstable_v2_createSession()` | V2 API 入口 |
| `Jh` / `unstable_v2_resumeSession()` | V2 resume 入口 |
| `cQ` | SDKSession class（V2 持久 session） |
| `h9` | Query class（control protocol, message routing） |
| `y9` | ProcessTransport class（spawn CLI process） |
| `g9` | InputStreamQueue（async iterable queue） |

---

## 九、結論

Agent SDK V1 的高成本根因是**每次 `query()` 都 spawn 新 cli.js process**，導致：
1. 所有 runtime system-reminders 被重新注入（內容每次略有不同）
2. Prompt cache prefix 不匹配 → cache WRITE（125% 費用）
3. 整個 conversation context 的 input tokens 都以 WRITE 費率計算
4. Cache efficiency 永遠卡在 ~25%

**Phase 1（消除個別 bust 源）的結果**：CLAUDE_CODE_REMOTE=1 和 JSONL Sanitizer 對 efficiency 無顯著改善（仍 25%），因為 system-reminder 注入的重組無法保證 byte-for-byte 相同。

**Phase 2（V2 persistent session）的結果**：Patch SDK V2 API 讓 cli.js process 持續存活，cache 跨訊息累積。實測 efficiency 從 20% → 84%（4 訊息內），完全解決問題。成本從 V1 的每訊息 ~1-3% 降到穩態 <0.5%。

---

## 十、A/B 測試數據（2026-03-15）

### 實測結果

同一對話 session，連續發送短訊息（"555"），間隔 11-90 秒：

| 時間 | CLAUDE_CODE_REMOTE | cacheRead | cacheCreation | efficiency | cost |
|---|---|---|---|---|---|
| 00:41:56 | **有** | 8,624 | 48,661 | **15%** | $0.309 |
| 00:42:53 | **有** | 11,945 | 45,499 | **21%** | $0.291 |
| 00:46:01 | **無** | 15,294 | 45,724 | **25%** | $0.294 |
| 00:47:31 | **無** | 15,294 | 45,735 | **25%** | $0.294 |
| 00:47:42 | **無** | 15,294 | 45,746 | **25%** | $0.294 |

### 結論

1. **CLAUDE_CODE_REMOTE=1 對 cache efficiency 無顯著影響**（15-25% 差異主要來自切換時的 prefix 變化）
2. **cacheRead 穩定在 ~15k**（= system prompt，永遠被 cache）
3. **cacheCreation 穩定在 ~45k**（= 對話歷史，每次都 WRITE，從不 READ）
4. **即使間隔 11 秒，efficiency 也不上升** — 確認 content prefix 每次都不同
5. **消除個別 bust 源無效** — 根因是 SDK 每次 spawn 新 process 時 runtime 注入重組無法 byte-for-byte 相同

**Phase 2（persistent session）是唯一真正的解法。**

### V2 Persistent Session 實測（含 MCP patch）

V2 session 保持 cli.js process 存活，cache 跨訊息持續累積：

| msg | cacheRead | cacheCreation | efficiency | 說明 |
|---|---|---|---|---|
| #1 | 11,689 | 45,974 | **20%** | 建立 cache（等同 V1 的首次） |
| #2 | 69,352 | 46,108 | **60%** | cache 開始命中 |
| #3 | 127,149 | 46,208 | **73%** | 持續爬升 |
| #4 | 402,087 | 78,011 | **84%** | numTurns=2，大量 cache READ |

對比 V1（永遠 25%），V2 在 msg #4 已達 **84%**，且會隨對話持續上升。

---

## 十一、最終實作清單

### 程式碼

| 檔案 | 類型 | 說明 |
|---|---|---|
| `scripts/patch-sdk-v2.cjs` | 新建 | postinstall script，5 個 patch 點（settingSources, cwd, thinking, extraArgs, h9-initConfig+MCP） |
| `package.json` | 改 | 加入 `"postinstall": "node scripts/patch-sdk-v2.cjs"` |
| `src/core/SDKSessionManager.ts` | 新建 | V2 persistent session wrapper，管理 session 生命週期 |
| `src/core/SDKQueryManager.ts` | 改 | `CLAUDE_CODE_REMOTE=1` + `cacheEfficiencyPct` monitoring |
| `src/core/MessageProcessor.ts` | 改 | resume 時優先走 V2，失敗自動降級 V1 |

### 研究文件

| 檔案 | 說明 |
|---|---|
| `_special-research/sdk-reverse-engineering-v76.md` | 本報告：完整流程全貌 + 根因 + 緩解方案 + 實測數據 |
| `_special-research/sdk-anchor-index-v76.md` | minified code 錨點索引 + patch 定位指南 |

### Patch 清單（patch-sdk-v2.cjs）

| # | id | 作用 |
|---|---|---|
| 1 | settingSources | V2 session 載入 CLAUDE.md 和 settings |
| 2 | cwd | V2 session 指定工作目錄（JSONL 路徑解析） |
| 3 | thinkingConfig | V2 session 配置 thinking/maxTurns/maxBudgetUsd |
| 4 | extraArgs | V2 session 傳遞額外 CLI 參數 |
| 5 | h9-initConfig-and-mcpServers | systemPrompt 傳入 + MCP SDK routing（從 Q.mcpServers 提取 instance 建 Map） |

### 架構決策

- **V2 persistent session 是主要路徑**：resume 時優先使用，process 存活 → cache 累積
- **V1 query() 是 fallback**：V2 失敗時自動降級，新 session（無 resume）也走 V1
- **MCP routing**：透過 h9 的 sdkMcpMap（in-process），非 CLI --mcp-config args
- **Session 無 idle timeout**：process 持續存活直到 ClaudeCab 重啟（未來可加）

### 已知限制

- V2 API 為 unstable preview，升級 SDK 時需驗證 patch 相容性
- 每個 V2 session ≈ 100-200MB RAM（一個 node process）
- ClaudeCab 重啟後所有 session 消失，下一訊息需重建 cache
