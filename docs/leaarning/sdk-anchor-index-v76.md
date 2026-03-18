# SDK Minified Code 錨點索引 + Patch 指南（v0.2.76）

**用途：** 每次 SDK 版本升級後，用這些不會變的字串常量來重新定位被 minify 的關鍵函數。
**版本基線：** `@anthropic-ai/claude-agent-sdk` v0.2.76 / Claude Code v2.1.76
**更新日期：** 2026-03-15
**主報告：** `sdk-reverse-engineering-v76.md`

---

## 使用方式

```bash
# 在 cli.js 中定位函數
grep -n "錨點字串" node_modules/@anthropic-ai/claude-agent-sdk/cli.js

# 在 sdk.mjs 中定位函數
grep -n "錨點字串" node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

每次升級 SDK 後：
1. 用錨點字串 grep 到新的行號
2. 在該行附近找到被 rename 的函數名
3. 更新本文件的「目前名稱」欄位

---

## cli.js 錨點（12MB minified）

### Prompt Caching 核心

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| Caching 啟用開關 | `IGq` | `"DISABLE_PROMPT_CACHING"` | 連續含 `_HAIKU`, `_SONNET`, `_OPUS` 變體 |
| cache_control 建構 | `Ml` | `ttl:"1h"` + `scope:"global"` 在同一函數 | 唯一產生 `{type:"ephemeral"}` 的函數 |
| 1h TTL 判斷 | `o3z` | `"ENABLE_PROMPT_CACHING_1H_BEDROCK"` | 也含 `"tengu_prompt_cache_1h_config"` |
| Beta headers 建構 | `Fr8` | `"prompt-caching-scope-2026-01-05"` | 所有 beta header 值在此定義 |
| Beta 常數定義區 | `lA1` 等 | `"claude-code-20250219"` | 鄰近行含所有 beta string |

### System Prompt Cache

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| Prompt 分段 boundary | `S_6` 變數 | `"__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__"` | 區分 static/dynamic cache scope |
| Prompt 分段函數 | `Jn8` | `"tengu_sysprompt_boundary_found"` | 也含 `"tengu_sysprompt_block"` |
| Prompt → API blocks | `_9z` | 在 `Jn8` 和 `z9z` 之間，搜 `"cacheScope"` | 呼叫 `Jn8` 和 `Ml` |

### Messages Cache

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| Messages cache breakpoint | `z9z` | `"tengu_api_cache_breakpoints"` | 放置最後 2 則 message 的 cache_control |

### System-Reminder 注入

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| gitStatus 取得 | `sf8` | `"git_status_started"` | `CLAUDE_CODE_REMOTE=1` 可跳過 |
| system context 組裝 | `mw` | `"system_context_started"` | 包裝 gitStatus 為 context 物件 |
| claudeMd/date 注入 | `a2` | `"user_context_started"` | 組裝 claudeMd + currentDate |
| claudeMd → message | `eE1` | `"context may or may not be relevant"` | 包在 `<system-reminder>` 中 |
| system-reminder wrapper | `af` | `"<system-reminder>"` (function 定義處) | `b5` 在 `af` 之後定義 |
| stale check (file diff) | `CuY` | `"was modified, either by the user"` | 產生 `edited_text_file` 注入 |
| stale check 調用 | -- | `"changed_files"` (鄰近 `"nested_memory"`) | 呼叫鏈入口 |
| meta message builder | `p1` | `"isVisibleInTranscriptOnly"` | 含 `isMeta`, `isCompactSummary` |

### readFileState

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| LRU Cache class | `R14` | `"sizeCalculation"` | 含 `Buffer.byteLength` |
| CLI LRU max = 100 | `Ed` | R14 class 後 ~100 bytes 找 `=100` | 與 `yv9=26214400` (max bytes) 相鄰 |
| SDK LRU max = 10 | `meY` / `Cs5` | 搜尋 C26/kKA 函數內的 `=10` | 在 readFileState rebuild 函數內 |
| LRU clone | `DI` | `.dump()` 配合 `.load(` | 唯一的 dump/load 組合 |

---

## sdk.mjs 錨點（405KB）

| 功能 | v76 名稱 | 錨點字串 | 備註 |
|---|---|---|---|
| **SDKSession class** | `cQ` | `"Cannot send to closed session"` | V2 持久 session |
| SDKSession.sessionId | `cQ` | `"Session ID not available until after receiving messages"` | getter 內 |
| **ProcessTransport** | `y9` | `"--output-format"` | spawn CLI 的 class |
| ProcessTransport args | `y9` | `"--setting-sources"` | spawn 參數建構 |
| **Query class** | `h9` | `"pendingControlResponses"` | control protocol |
| **query() 入口** | `Yh` | `"CLAUDE_AGENT_SDK_VERSION"` | V1 API 入口 |
| query() 入口 (backup) | `Yh` | `"Fallback model cannot be the same"` | |

---

## 目前 Patch 清單（patch-sdk-v2.cjs, v0.2.76）

共 5 個 patch，全部作用於 cQ class（SDKSession constructor）：

| # | id | 目標 | find → replace |
|---|---|---|---|
| 1 | `settingSources` | y9 params | `settingSources:[]` → `Q.settingSources??[]` |
| 2 | `cwd` | y9 params | 在 `abortController:this.abortController` 前插入 `cwd:Q.cwd,` |
| 3 | `thinkingConfig` | y9 params | `thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0` → 從 `Q` 讀取 |
| 4 | `extraArgs` | y9 params | `extraArgs:{}` → `Q.extraArgs??{}` |
| 5 | `h9-initConfig-and-mcpServers` | h9 constructor | `new Map` → IIFE 從 `Q.mcpServers` 提取 SDK instances 建 Map + 加入 initConfig |

### Patch 5 的 MCP routing 邏輯

V1 `query()` 把 `mcpServers` 分成兩路：
- `type:"sdk"` + `instance` → 放進 h9 的 sdkMcpMap（in-process routing）
- 其他 → 序列化為 `--mcp-config` CLI args

Patch 5 在 cQ 裡用 IIFE 複製 V1 邏輯：
```javascript
(()=>{
  let m = new Map;
  if (Q.mcpServers)
    for (let [k,v] of Object.entries(Q.mcpServers))
      if (v.type === "sdk" && "instance" in v)
        m.set(k, v.instance);
  return m;
})()
```

h9 constructor 的第 6 個參數就是這個 Map，constructor 內部會 `for (let [z,K] of W) this.connectSdkMcpServer(z,K)` 建立路由。

## Patch 定位指南