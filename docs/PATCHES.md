# SDK patch audit

> 本文件保留舊 patch 的結論，並記錄 agent-sdk 0.3.238 的重新檢查結果。

完整 migration timeline 見 [`docs/SDK-TIMELINE.md`](./SDK-TIMELINE.md)。

## 結論（0.3.238）

舊版直接修改 SDK 內部 `cli.js` 的 1–5 號 patch 不再需要，也沒有重新套用：

| 舊 patch | 目前判定 | 依據 |
| --- | --- | --- |
| context 安全邊距 | 移除 | SDK 已公開 `autoCompactWindow` 與 `SDKContextUsage`；由 SDK 管理 compact window |
| fork 裁剪 | 移除 | SDK 已公開 `forkSession()`，fork 邏輯不應再靠內部行號 patch 維護 |
| subagent 裁剪 | 移除 | SDK 已公開 `SubagentStart` hook；上層若要補 context，使用 hook |
| SDK 啟用 prompt cache | 移除 | SDK 已原生支援 cacheable system-prompt prefix 與 dynamic boundary |
| streaming 失敗不重送 | 移除 | 這是 SDK 內部 transport/retry 行為，版本庫沒有現存 binary patch |
| cumulative usage diff | 保留 | `result.modelUsage` 在新版型別文件仍明確標示為 streaming-input session 累積快照；實作於 `src/context-manager.ts` |

目前真正屬於本 wrapper 的能力是：公開 streaming-input API 的 `send/stream/close` adapter、history-keyed session pool、客製化 handoff/restart、cache keepalive、rapid-refill breaker，以及 Ollama/OpenAI bridge。這些不是 SDK 內部 patch，不能因為 SDK 更新而直接刪除。

### 新版仍可保留的上層工具

- `ContextManager`：保留。它提供產品層的 handoff/restart、keepalive 與 breaker；SDK auto-compact 只取代其中一部分 context window 控制。
- persistent session adapter：保留。它把 SDK 的 continuous generator 轉成 bridge 與 agent bot 需要的 per-turn adapter。
- `createCacheOptimizer`：保留但定位為 optional。SDK 已負責 cache，本工具只排序 options、統計 hit rate，不再宣稱「開啟 cache」。
- `createTokenTracker`：保留。SDK 的 cumulative usage 需要 wrapper 做 per-turn diff 與 budget/reporting。
- `createContextPruner` / `createOptimizedQuery`：保留但需按使用場景啟用；它們是 hook-based policy，不是 SDK 必需品。
- Ollama/OpenAI bridge：保留。它是 protocol adapter，不是 SDK 已提供的同等功能；client CLI/TUI 已移除。

目前沒有足夠的實際使用量資料判定 optional optimize utilities 是否被下游使用；本次不刪除公開 exports，只移除「需要 patch SDK 才能工作」的歷史敘述。

> 以下段落是 `@anthropic-ai/claude-agent-sdk` v0.2.77 時代的歷史記錄，不是目前更新流程。

## 歷史 patch（0.2.x）

官方 SDK 為單人互動設計，我們拿來跑 7 個 agent 同時運作，所以要砍掉浪費 token 的地方。

## 6 個 Patch

```text
#   改什麼              為什麼                          省多少
─── ─────────────────── ─────────────────────────────── ──────
1   context 安全邊距     1000→200 tokens                 多用 800 tokens
    ~L236819            官方太保守，白白浪費 context

2   fork 裁剪           只帶最近 5 輪                    fork 成本 -80%
    ~L346651            官方會複製整段對話歷史到 fork
                        7 個 agent 串起來會指數爆炸

3   subagent 裁剪       只帶最近 10 則訊息               冷啟動 -60%
    ~L391538            Agent tool 產生的子 agent
                        不需要父對話的完整歷史

4   SDK 啟用 cache      讓 sdk 也能用 prompt cache       最大的一刀
    ~L455180            官方只開給 REPL（互動式 CLI）
                        我們的 agent 每次都送一樣的
                        system prompt，不 cache = 浪費

5   串流失敗不重送      已收到內容就不重試               避免 2x token
    ~L455529            官方串流斷掉會整個重送
                        但我們已經拿到部分回應了

6   usage 語義硬化      cumulative modelUsage 轉 delta    避免 watermark 失真
    src/context-manager.ts
                        result.usage/modelUsage 是 session 累積快照
                        ContextManager 需先 diff 再估算 context
```

## 改法

前 5 個 patch 主要改在 `src/cli.js`（53 萬行，已 beautify）。
第 6 個 patch 改在 `src/context-manager.ts`，用 cumulative snapshot 做 delta，避免 watermark / keepalive 估算失真。

找到對應行號，改幾個數字或加一個 if 判斷就好。不是大手術。

```bash
# 重新套 patch 的流程：
bash packages/sdk/scripts/patch.sh   # beautify 新版 cli.js
# 然後手動對照上面 5 個位置改回去
```

## 為什麼能用 Max 訂閱跑 agent

```text
claude login          # OAuth 認證，存 token 到本機
     |
     v
query({ prompt })     # SDK 用存好的 token 呼叫
     |
     v
Claude Code binary    # cli.js 裡面的 agent loop
     |
     v
Claude API            # 走 Max 訂閱額度，不走 API 計費
```

Max 訂閱 = 月費吃到飽。7 個 agent 同時跑不會破產。
唯一限制是 rate limit（token/min），所以 patch 的重點都是「少送 token」。

## 角色權限對照

```text
角色     tools                          說明
──────── ────────────────────────────── ────────────────
夜梨 PM  Read, Glob, Grep               只能看，不能改
卡爾 HR  Read, Glob, Grep               只能看，不能改
Reef 後  Read, Write, Edit, Bash, Glob  全套開發工具
Tide 前  Read, Write, Edit, Bash, Glob  全套開發工具
Pearl 設 Read, Write, Edit, Glob, Grep  沒有 Bash
Shell 維 Read, Write, Edit, Bash, Glob  全套 + 部署
Otter 雜 Read, Write, Edit, Bash, Glob  什麼都能碰
```

PM 沒有 Write/Edit/Bash = 她只能透過 Discord @mention 指揮別人做事。
這就是「各司其職」的硬限制。
