# V2 Persistent Session 工程筆記

**日期：** 2026-03-18
**版本：** SDK v0.2.77 (patched)
**前置研究：** sdk-reverse-engineering-v76.md, system-reminder-調查報告.md

---

## 一、為什麼需要 V2

### V1 query() 的問題

```text
每次 query() → spawn 新 cli.js process → runtime 注入不同（gitStatus/mtime）
→ messages prefix 不匹配 → 整段 cache WRITE（125% 費用）
→ cache efficiency ≈ 25%
```

V1 唯一能 cache hit 的是 system prompt（~15K tokens），messages 部分每次都是 WRITE。

### V2 createSession() 的解法

```text
createSession() → 保持同一個 cli.js process alive
→ runtime 注入穩定 → messages prefix byte-for-byte 相同
→ cache READ（25% 費用）
→ cache efficiency ≈ 84%+ (warmup 後)
```

### 實測數據（上一個 session 的 A/B 測試）

| 模式 | 5 次 "555" 平均 efficiency | 成本比 |
|------|---------------------------|--------|
| V1 query() fresh process | 25.3% | 1.0x |
| V1 query() + resume | 41.7% | 0.76x |
| V2 createSession() | 84.2% | 0.38x |

---

## 二、Patch 技術細節

### 目標：dQ class (SDKSession)

V2 的 `unstable_v2_createSession()` 內部建立 `dQ` 實例。
`dQ` 的 constructor 硬編碼了大量欄位，導致從外部傳入的 options 被忽略。

### Patch 清單（5 處）

Patch script：`packages/sdk/scripts/patch-v2.sh`

#### Patch 1: settingSources

```text
find:    resume:Q.resume,settingSources:[]
replace: resume:Q.resume,settingSources:Q.settingSources??[]
```

作用：讓 V2 session 讀取 `.claude/settings.json`、CLAUDE.md 等設定來源。
無此 patch：session 不讀取任何 settings，行為與 CLI 不一致。

#### Patch 2: cwd

```text
find:    ({abortController:this.abortController,pathToClaudeCodeExecutable:X,env:Y
replace: ({cwd:Q.cwd,abortController:this.abortController,pathToClaudeCodeExecutable:X,env:Y
```

作用：讓 V2 session 在指定的 working directory 執行。
注意：find string 包含 `({` prefix 確保 idempotency（patch 後 `({` 接的是 `cwd:Q.cwd,` 不再匹配）。

#### Patch 3: thinkingConfig + extraArgs + maxTurns + maxBudgetUsd

```text
find:    extraArgs:{},thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0
replace: extraArgs:Q.extraArgs??{},thinkingConfig:Q.thinkingConfig,maxTurns:Q.maxTurns,maxBudgetUsd:Q.maxBudgetUsd
```

作用：讓 V2 session 的 thinking、turns 限制、budget 限制可由外部控制。

#### Patch 4: mcpServers（CLI args 過濾）

```text
find:    mcpServers:{},strictMcpConfig:!1,canUseTool:!!Q
replace: mcpServers:(()=>{if(!Q.mcpServers)return{};
         let r={};for(let[k,v]of Object.entries(Q.mcpServers))
         if(!v||v.type!=="sdk")r[k]=v;return r})(),
         strictMcpConfig:!1,canUseTool:!!Q
```

作用：傳入 mcpServers 但過濾掉 `type: "sdk"` 的（那些由 SDK 內部透過 sdkMcpMap 處理）。

#### Patch 5: g9 sdkMcpMap + initConfig（systemPrompt）

```text
find:    Q.hooks,this.abortController,new Map),this.query.streamInput
replace: Q.hooks,this.abortController,
         (()=>{let m=new Map;
         if(Q.mcpServers)for(let[k,v]of Object.entries(Q.mcpServers))
         if(v&&v.type==="sdk"&&"instance" in v)m.set(k,v.instance);
         return m})(),
         void 0,
         {systemPrompt:Q.systemPrompt,appendSystemPrompt:Q.appendSystemPrompt},
         void 0),
         this.query.streamInput
```

作用：(1) 把 `type: "sdk"` 的 MCP server instances 放進 sdkMcpMap
      (2) 注入 initConfig 第 8 個參數（systemPrompt / appendSystemPrompt）

### g9 constructor 參數對應（v0.2.77）

```text
g9(transport, isSingleUserTurn, canUseTool, hooks, abortController,
   sdkMcpMap, jsonSchema, initConfig, onElicitation)

initConfig = {
  systemPrompt: string,
  appendSystemPrompt: string,
  // ...
}
```

---

## 三、Idempotency 設計

所有 5 個 patch 的 find string：

1. patch 後不再出現在檔案中（被 replace 取代了不同的 prefix/suffix）
2. 不是 replace string 的子字串
3. 在 sdk.mjs 中只出現一次

驗證方法：

```bash
bash packages/sdk/scripts/patch-v2.sh --check
# Expected: "All 5 patches are applicable" 或 "SDK is already patched"
```

---

## 四、升級維護

SDK 升級到 v0.2.78+ 時：

1. `patch-v2.sh --check` 確認 find strings 是否還在
2. 如果 MISS → 用錨點字串重新定位：
   - "Cannot send to closed session" → dQ class
   - "settingSources" → dQ constructor
   - "pathToClaudeCodeExecutable" → ProcessTransport.initialize
3. 更新 `sdk-anchor-index-v76.md` 為新版本

### 符號對照（已知版本）

| 功能 | v0.2.76 | v0.2.77 |
|------|---------|---------|
| SDKSession | cQ | dQ |
| Query | h9 | g9 |
| ProcessTransport | y9 | x9 |

---

## 五、已知限制

1. **SDKSessionOptions 型別不完整** — 原生 d.ts 缺少 systemPrompt/cwd/maxTurns 等。lobster-core 用 `SDKSessionOptions & Record<string, unknown>` + `as SDKSessionOptions` 繞過。
2. **`/compact` 觸發方式** — V2 session 沒有官方 compact API，目前用 `session.send('/compact')` 當 user message 觸發 CLI 內建 slash command。
3. **Cache TTL 1 小時** — Max 訂閱的 cache TTL 是 1hr（vs 預設 5min）。超過 1hr 無活動，整個 cache 會過期。
4. **Unstable API** — `unstable_v2_*` 隨時可能改變，lobster-core 有 V1 fallback 機制。
