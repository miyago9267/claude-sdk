# SDK 魔改懶人包

> 基於 `@anthropic-ai/claude-agent-sdk` v0.2.77，5 刀改完。

## 一句話

官方 SDK 為單人互動設計，我們拿來跑 7 個 agent 同時運作，所以要砍掉浪費 token 的地方。

## 5 個 Patch

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
```

## 改法

全部改在 `src/cli.js`（53 萬行，已 beautify）。

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
