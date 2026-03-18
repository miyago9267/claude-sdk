# V2 Session × Lobster-Core 整合架構

**日期：** 2026-03-18
**前置研究：** v2-persistent-session-工程筆記.md

---

## 一、架構總覽

```text
                    ┌─────────────────────────────────────┐
                    │         Lovely Office Runtime        │
                    │                                      │
                    │  office-main.ts                      │
                    │    └─ spawnLobster(role)              │
                    │         └─ new Lobster(config)       │
                    │              ├─ useV2: true (預設)    │
                    │              └─ setChannel(discord)   │
                    └────────────────┬────────────────────┘
                                     │ .run()
                    ┌────────────────▼────────────────────┐
                    │         Lobster (lobster-core)       │
                    │                                      │
                    │  run()                               │
                    │    ├─ V2: createSession(opts)        │
                    │    │  或 resumeSession(id, opts)      │
                    │    └─ V1 fallback: sessionId only    │
                    │                                      │
                    │  interact(msg)                       │
                    │    ├─ V2: session.send() + stream()  │
                    │    ├─ V1: query({ prompt, options }) │
                    │    └─ trackTokenUsage(result)        │
                    │         └─ checkContextWatermark()   │
                    │              ├─ compact: /compact    │
                    │              └─ restart: new session  │
                    │                                      │
                    │  stop()                              │
                    │    └─ session.close()                │
                    └────────────────┬────────────────────┘
                                     │
                    ┌────────────────▼────────────────────┐
                    │    @lovely-office/sdk (patched)      │
                    │                                      │
                    │  unstable_v2_createSession(opts)     │
                    │    └─ new dQ(opts)  ← patch-v2.sh   │
                    │         ├─ cwd ✓                    │
                    │         ├─ systemPrompt ✓            │
                    │         ├─ maxTurns / budget ✓       │
                    │         ├─ mcpServers ✓              │
                    │         └─ settingSources ✓          │
                    │                                      │
                    │  SDKSession                          │
                    │    ├─ send(msg)                      │
                    │    ├─ stream() → AsyncGenerator      │
                    │    ├─ close()                        │
                    │    └─ sessionId                      │
                    └─────────────────────────────────────┘
```

---

## 二、Session 生命週期

```text
Office 啟動
  │
  ▼
Lobster.run()
  │
  ├─ 有 saved sessionId?
  │    ├─ 是 → resumeSession(id, opts) → V2 session alive
  │    └─ 否 → createSession(opts) → V2 session alive
  │         (失敗 → fallback V1 mode)
  │
  ▼
Message Loop (while running)
  │
  ├─ Discord @mention → interact(msg)
  │    ├─ V2: session.send(msg) → stream() → collect result
  │    └─ V1: query({ prompt, options }) → iterate → collect
  │    │
  │    ├─ trackTokenUsage(resultMsg)
  │    │    └─ 更新: inputTokens, outputTokens, cacheRead,
  │    │       cacheCreation, efficiency, contextEstimate
  │    │
  │    └─ checkContextWatermark()
  │         ├─ < 150K tokens → pass
  │         └─ >= 150K tokens
  │              ├─ compact 策略: session.send('/compact')
  │              │    └─ stream() → 讀 post-compact tokens
  │              └─ restart 策略: session.close() + createSession()
  │
  ├─ Heartbeat → interact(heartbeatPrompt, 'heartbeat')
  │    └─ 同上流程
  │
  └─ V2 Error → 自動 fallback V1
       └─ useV2 = false, session = null, retry interact()

Office 關閉
  │
  ▼
Lobster.stop()
  └─ session.close() + clearTimeout(heartbeat)
```

---

## 三、Token 追蹤欄位

### LobsterStats（每隻龍蝦獨立追蹤）

| 欄位 | 來源 | 說明 |
|------|------|------|
| totalInputTokens | modelUsage.inputTokens | 累計 non-cached input |
| totalOutputTokens | modelUsage.outputTokens | 累計 output |
| totalCacheReadTokens | modelUsage.cacheReadInputTokens | 累計 cache hit |
| totalCacheCreationTokens | modelUsage.cacheCreationInputTokens | 累計 cache write |
| cacheEfficiency | cacheRead / (input + read + creation) | 0-1 即時效率 |
| contextTokensEstimate | 最近一次 sum(input + read + creation) | 當前 context 大小 |
| estimatedCostUsd | resultMsg.total_cost_usd 累加 | SDK 自算的費用 |

### 效率判讀

```text
> 80%  良好（V2 session warmup 後正常值）
50-80% 部分 cache hit（V2 剛建立/resume 不久）
< 50%  嚴重 cache bust（可能 fallback 到 V1 了）
< 25%  V1 模式（每次 fresh process）
```

---

## 四、Context Watermark 機制

### 設定

| Config 欄位 | 預設值 | 說明 |
|-------------|--------|------|
| contextWatermarkTokens | 150,000 | 觸發門檻（tokens） |
| contextCompactStrategy | 'compact' | compact 或 restart |

### 為什麼 150K？

- Claude Max context window = 200K
- system prompt ≈ 15-20K
- compact 需要一次額外 API call ≈ 10-20K output
- 留 30-50K buffer 給 compact 操作本身
- 150K 是「context 快滿但還有空間做 compact」的甜蜜點

### Compact 策略 vs Restart 策略

| | compact | restart |
|--|---------|---------|
| 方式 | send('/compact') | close() + createSession() |
| Context 保留 | 壓縮摘要 | 全部丟失 |
| Cache | 保持 warm | 需要 warmup |
| 適用 | 長對話需要保留記憶 | 無狀態任務 |
| 風險 | /compact 可能失敗 | 丟失 conversation history |

### 建議配置

```text
PM/HR agent (yari/karl):
  contextWatermarkTokens: 100_000  # 管理角色不需要太長 context
  contextCompactStrategy: 'restart'  # 每次任務獨立

Developer agent (reef/tide):
  contextWatermarkTokens: 150_000  # 寫 code 需要較長 context
  contextCompactStrategy: 'compact'  # 保留 code 上下文

Otter:
  contextWatermarkTokens: 80_000  # haiku context window 較小
  contextCompactStrategy: 'restart'
```

---

## 五、V1 Fallback 機制

三層防護：

1. **run() 建立失敗** → `useV2 = false`，用 V1 sessionId resume
2. **interact() V2 執行失敗** → `useV2 = false`，recursive call 自己走 V1
3. **compact 失敗** → fallback 到 restart strategy

所有 fallback 都是 **不可逆的** — 一旦 fallback 到 V1，這個 Lobster 實例不會再嘗試 V2。
需要重啟整個 process 才會重新嘗試 V2。

---

## 六、Office 接入

### 零改動接入

`spawn.ts` 的 `toLobsterConfig()` 不含 `useV2Session` → 預設 `true`。
`office-main.ts` 的 `spawnLobster()` → `new Lobster(config)` → 自動走 V2。

### 可選配置（未來）

在 `spawn.ts` 的 `toLobsterConfig()` 加入：

```typescript
// 環境變數控制 V2 開關
useV2Session: process.env.LOVELY_V2_SESSION !== 'off',
// 或 per-agent 配置
contextWatermarkTokens: ac.role === 'otter' ? 80_000 : 150_000,
contextCompactStrategy: ['yari', 'karl'].includes(role) ? 'restart' : 'compact',
```

### 驗證步驟

```bash
# 1. 確認 SDK patch 已套用
bash packages/sdk/scripts/patch-v2.sh --check

# 2. Build lobster-core
cd packages/lobster-core && bun run build

# 3. 單隻龍蝦測試
bun run src/lobsters/office-main.ts otter

# 4. 觀察 log 輸出
# [otter] V2 session created        ← 看到這個就是 V2 啟動成功
# [otter] V2 session resumed: xxx   ← 或 resume 成功
# [otter] V1 resumed session: xxx   ← 這個是 fallback 到 V1
```
