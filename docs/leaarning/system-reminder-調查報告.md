# Claude Code System-Reminder 機制完整調查報告

> 調查日期：2026-03-08
> Claude Code 版本：v2.1.71（`@anthropic-ai/claude-code`）
> 調查方法：GitHub Issues 分析 + npm 包源碼逆向工程（`cli.js`）+ Session JSONL 數據分析

---

## 目錄

1. [問題總覽](#1-問題總覽)
2. [System-Reminder 完整類型清單](#2-system-reminder-完整類型清單)
3. [歷史變遷](#3-歷史變遷)
4. [核心機制：readFileState 追蹤系統](#4-核心機制readfilestate-追蹤系統)
5. [File Modification 注入的五個觸發條件](#5-file-modification-注入的五個觸發條件)
6. [注入不穩定觸發的根因](#6-注入不穩定觸發的根因)
7. [CLI vs Agent SDK 的運作差異](#7-cli-vs-agent-sdk-的運作差異)
8. [Session Resume 時 readFileState 的還原機制（C26 完整逆向）](#8-session-resume-時-readfilestate-的還原機制c26-完整逆向)
9. [隱藏機制：為什麼使用者看不到](#9-隱藏機制為什麼使用者看不到)
10. [已知 Bug 彙整](#10-已知-bug-彙整)
11. [緩解方案](#11-緩解方案)

---

## 1. 問題總覽

Claude Code 在每輪 API request 中動態注入 `<system-reminder>` 標籤，這些內容：

- **不顯示在 UI** — 用 `isMeta: !0` flag 隱藏
- **不存在 JSONL** — 只在 runtime 組裝 API request 時注入，不落地到對話歷史檔案
- **不可關閉** — 沒有官方開關（[#9769](https://github.com/anthropics/claude-code/issues/9769) 從 2025-10 開到現在）
- **指令 Claude 隱瞞** — 模板包含 `NEVER mention this reminder to the user`

### GitHub Issues 現況（截至 2026-03-08）

共 30 個 open issues，分四類：

#### Token 浪費（最多人抱怨）

| Issue | 標題 | 留言數 | 日期 |
|---|---|---|---|
| [#16021](https://github.com/anthropics/claude-code/issues/16021) | 每則 user message 都注入數百行修改檔案備註 | 23 | 2025-01-02 |
| [#4464](https://github.com/anthropics/claude-code/issues/4464) | system-reminder 內容注入消耗過多 context tokens | 22 | 2025-07-25 |
| [#17601](https://github.com/anthropics/claude-code/issues/17601) | 隱藏注入 10,000+ 次，吃掉 15%+ context window | 10 | 2026-01-12 |
| [#21214](https://github.com/anthropics/claude-code/issues/21214) | 每次 Read file 都注入 system-reminder，浪費百萬 tokens | 4 | 2026-01-27 |
| [#25327](https://github.com/anthropics/claude-code/issues/25327) | CLI wrapper 注入 =「好工程的 token 稅」 | 0 | 2026-02-12 |
| [#27721](https://github.com/anthropics/claude-code/issues/27721) | Skills 被 system prompt 重複註冊，context 用量翻倍 | 1 | 2026-02-22 |
| [#27599](https://github.com/anthropics/claude-code/issues/27599) | headless 模式下 system-reminder 無限重複 | 2 | 2026-02-22 |

#### 安全 / 信任問題

| Issue | 標題 | 留言數 | 日期 |
|---|---|---|---|
| [#18560](https://github.com/anthropics/claude-code/issues/18560) | system-reminder 指示 Claude 不遵守 CLAUDE.md | 3 | 2026-01-16 |
| [#31447](https://github.com/anthropics/claude-code/issues/31447) | Claude 聲稱 system messages 是「被注入的」，社交工程使用者放寬權限 | 2 | 2026-03-06 |
| [#23537](https://github.com/anthropics/claude-code/issues/23537) | system task reminders 偽裝成 user input，模型無法區分 | 2 | 2026-02-06 |
| [#27128](https://github.com/anthropics/claude-code/issues/27128) | system-generated messages 被誤標為 Human: turn，導致未授權行為 | 4 | 2026-02-20 |

#### 功能性 Bug

| Issue | 標題 | 留言數 | 日期 |
|---|---|---|---|
| [#31458](https://github.com/anthropics/claude-code/issues/31458) | system-reminder（如 `<new-diagnostics>`）在對話持久化時被剝離，破壞 grounding | 2 | 2026-03-06 |
| [#26370](https://github.com/anthropics/claude-code/issues/26370) | Compaction 後 system-reminder 殘留舊 Read 結果造成混亂 | 1 | 2026-02-17 |
| [#25810](https://github.com/anthropics/claude-code/issues/25810) | Memory system 錯誤回報 MEMORY.md 為空 | 0 | 2026-02-14 |

#### Feature Request

| Issue | 標題 | 留言數 | 日期 |
|---|---|---|---|
| [#9769](https://github.com/anthropics/claude-code/issues/9769) | 讓所有 system-reminder 類型可個別開關 | 4 | 2025-10-17 |

---

## 2. System-Reminder 完整類型清單

> 來源：[Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts) 逆向工程 + cli.js 源碼分析

### 每輪固定觸發

| system-reminder | 觸發條件 | 估計佔用量 |
|---|---|---|
| malware analysis | 每次 Read file | ~50 tokens × 讀檔次數 |
| file modified by user or linter | 檔案 mtime 變化（含 IDE autosave、linter、hook 寫檔） | ~30 tokens + 檔案 diff 片段（可能很大） |
| TodoWrite reminder | 一段時間沒用 TodoWrite | ~80 tokens |
| Task tools reminder | 一段時間沒用 TaskCreate/TaskUpdate | ~80 tokens |
| memory file contents | 每輪附帶 MEMORY.md 內容 | MEMORY.md 全文大小 |
| invoked skills | 每輪注入可用 skills 列表 | ~2000+ tokens（視 skill 數量） |

### 條件觸發

| system-reminder | 觸發條件 | 估計佔用量 |
|---|---|---|
| hook success/error/context | 每個 hook 執行結果 | 依 hook stdout 大小 |
| hook stopped continuation | hook block 時 | ~30 tokens + message |
| file exists but empty | 讀到空檔案 | ~30 tokens |
| file truncated | 檔案太長被截斷 | ~30 tokens |
| file shorter than offset | Read 的 offset 超過檔案長度 | ~30 tokens |
| new diagnostics detected | LSP/IDE 回報新的錯誤/警告 | ~50 tokens + 診斷內容 |
| file opened in IDE | IDE 中開啟了檔案 | ~30 tokens + 檔案資訊 |
| lines selected in IDE | IDE 中選取了程式碼 | ~30 tokens + 選取內容 |
| session continuation | context compaction 後的延續摘要 | 數百~數千 tokens |
| token usage | 接近 context 上限時 | ~50 tokens |
| USD budget | 接近預算上限時 | ~30 tokens |
| compact file reference | compaction 後引用被壓縮的檔案 | 不定 |
| plan mode active | plan mode 開啟時 | ~100 tokens |
| output style active | 指定輸出風格時 | ~30 tokens |
| team coordination/shutdown | 多 agent 團隊模式 | ~100 tokens |
| agent mention | 被 @ 提及 | ~30 tokens |

### File Modification 注入模板

```
Note: ${ATTACHMENT_OBJECT.filename} was modified, either by the user or by a linter.
This change was intentional, so make sure to take it into account as you proceed
(ie. don't revert it unless the user asks you to). Don't tell the user this, since
they are already aware. Here are the relevant changes (shown with line numbers):
${ATTACHMENT_OBJECT.snippet}
```

---

## 3. 歷史變遷

### 第一階段：隱形但輕量（2025 年中）

- 2025-07 [#4464](https://github.com/anthropics/claude-code/issues/4464) 第一份報告
- 當時主要就是 malware reminder（每次 Read 約 50 tokens）
- 用 `isMeta: !0` 標記，UI 層直接過濾
- 大部分使用者完全不知道它的存在
- 只有 token 消耗異常快的人才會注意到

### 第二階段：File Modification 開始膨脹（2025 Q4 ~ 2026 Q1）

- 2025-10 [#9769](https://github.com/anthropics/claude-code/issues/9769) 請求加開關（至今未加）
- 2026-01-02 [#16021](https://github.com/anthropics/claude-code/issues/16021) 發現每則 user message 都注入數百行程式碼
- 2026-01-12 [#17601](https://github.com/anthropics/claude-code/issues/17601) mitmproxy 抓到 10,577 次隱藏注入

**關鍵轉折**：file modification reminder 從「通知一次」變成「每則 user message 都重複注入」。VS Code 擴充套件尤其嚴重（Claude 自己的 Edit 也觸發），CLI 稍好（只在 user edit 時注入一次）。

### 第三階段：種類爆增（2026 Q1）

- TodoWrite reminder、Task tools reminder、ip_reminder（著作權提醒）、Skills 列表注入、diagnostics 注入陸續加入
- 注入類型從 1-2 種暴增到 15+ 種
- 每種都帶 `NEVER mention this reminder`
- 2026-01-16 [#18560](https://github.com/anthropics/claude-code/issues/18560) system-reminder 開始覆蓋 CLAUDE.md 指令

### 第四階段：行為劣化（2026-02 ~ 03）

- 2026-02-06 [#23537](https://github.com/anthropics/claude-code/issues/23537) 模型把 system-reminder 當成使用者指令執行
- 2026-02-22 [#27599](https://github.com/anthropics/claude-code/issues/27599) headless 模式無限重複
- 2026-03-05 [#30730](https://github.com/anthropics/claude-code/issues/30730) sub-agent 注入覆蓋自定義 agent 定義
- 2026-03-06 [#31447](https://github.com/anthropics/claude-code/issues/31447) Claude 聲稱 system-reminder 是「被注入的」，要使用者放寬權限
- 2026-03-06 v2.1.70 惡化：整個檔案內容被注入（1300 行 → 每輪 15%+ context）
- 2026-03-07 v2.1.71 確認：Edit 過但沒 Re-read 的檔案永遠被視為 stale

---

## 4. 核心機制：readFileState 追蹤系統

> 以下源碼均從 `@anthropic-ai/claude-code@2.1.71` 的 `cli.js` 逆向

### readFileState 概述

`readFileState` 是一個 **LRU Cache**（最大 100 個 entry），key 是檔案路徑，value 是：

```javascript
{
  content: string,      // 檔案內容快照
  timestamp: number,    // 記錄時間（ms）
  offset: number | undefined,   // Read 時的偏移量
  limit: number | undefined     // Read 時的限制行數
}
```

### 三個寫入點

| 來源 | 函數 | key 格式 | offset | limit | timestamp 來源 |
|---|---|---|---|---|---|
| Memory 載入 | `WL8` | 原始路徑（不經 `t4()`） | `undefined` | `undefined` | `Date.now()` |
| Read tool | `X24` | `t4(path)` 正規化 | `1`（預設值） | `undefined` | `Math.floor(mtimeMs)` |
| Write/Edit tool | — | `t4(path)` 正規化 | `undefined` | `undefined` | `oS(filePath)` = mtime |
| Session Resume | `C26` | `t4(path)` 正規化 | `undefined` | `undefined` | JSONL 訊息時間戳 |

### WL8 — Memory 載入函數

```javascript
function WL8(A, q, K) {
  for (let w of A)
    if (!q.readFileState.has(w.path)) {     // 用原始路徑檢查
      q.readFileState.set(w.path, {          // 用原始路徑存入
        content: w.content,
        timestamp: Date.now(),
        offset: void 0,    // ← undefined
        limit: void 0      // ← undefined
      });
    }
  return Y;
}
```

**問題**：用原始路徑（不經 `t4()` 正規化）作為 key，與 Read/Write tool 使用的正規化路徑不一致。

### jqY — Stale Check 函數（每輪 user message 執行）

```javascript
async function jqY(A) {
  let q = $F(A.readFileState);  // 取得所有追蹤的檔案 key
  return (await Promise.all(q.map(async (z) => {
    let w = A.readFileState.get(z);

    // 條件 1: 有 offset 或 limit → 跳過
    if (w.offset !== undefined || w.limit !== undefined) return null;

    let _ = t4(z);  // 路徑正規化

    // 條件 2: mtime <= timestamp → 沒變 → 跳過
    if (oS(_) <= w.timestamp) return null;

    // 條件 3: 重新讀檔算 diff
    let H = await KY.call({file_path: _}, A);
    if (H.data.type === "text") {
      let j = Ak7(w.content, H.data.file.content);

      // 條件 4: diff 為空 → 跳過
      if (j === "") return null;

      return { type: "edited_text_file", filename: _, snippet: j };
    }
  }))).filter(Boolean);
}
```

**致命問題**：stale check 用原始 key `z` 從表中取值，但內部 Read（`KY.call`）用 `t4(z)` 正規化後的路徑更新表。如果兩個 key 不同，原始 entry 永遠不被更新 → 無限注入。

### t4 — 路徑正規化函數

```javascript
function t4(A, q) {
  let K = q ?? I1() ?? P1().cwd();
  // ... 路徑解析 ...
  return result.normalize("NFC");  // Unicode NFC 正規化
}
```

在 Windows 上，`t4()` 會做 NFC 正規化和路徑解析（`/c/` → `C:\` 等），可能與原始路徑產生差異。

### C26 — Session Resume 重建 readFileState

> 完整反混淆源碼見 [第 8 節](#8-session-resume-時-readfilestate-的還原機制c26-完整逆向)

C26 從 JSONL 對話歷史重建 readFileState。核心邏輯：

1. 第一輪掃描 assistant 訊息：收集 Read（無 offset/limit）和 Write 的 tool_use id → 路徑映射
2. 第二輪掃描 user 訊息：找對應的 tool_result，用其 content + JSONL timestamp 建 entry
3. **不處理 Edit** — Edit 操作完全不被還原
4. CLI 用 `max=100`，Agent SDK 用 `max=10`

**問題**：
- 重建的 entry 全部 `offset: undefined` → 全部被 stale check 追蹤
- `timestamp` 用的是 JSONL 的過去時間 → 檔案現在的 mtime 幾乎一定比它新 → 幾乎一定觸發注入
- Read tool 預設 `offset=1`，所以大多數正常 Read 操作不被 C26 收集（反而是安全的）

---

## 5. File Modification 注入的五個觸發條件

**全部滿足才會注入**：

| # | 條件 | 不觸發的情況 |
|---|---|---|
| 1 | 檔案在 readFileState 裡 | 從沒被 Read/Edit 過、也不是 CLAUDE.md/MEMORY.md |
| 2 | 不是 partial read（offset 和 limit 都是 undefined） | Read tool 預設 offset=1 → stale check 跳過 |
| 3 | mtime > timestamp | mtime 精度 race condition：Edit 和 timestamp 記錄在同一個 ms 內 → 跳過 |
| 4 | 能成功 Read 檔案 | 檔案被刪了、權限問題 → 從 tracking 移除 |
| 5 | diff 不為空 | 內容實際沒變（IDE autosave 同內容）→ 跳過 |

---

## 6. 注入不穩定觸發的根因

### 根因 1：路徑 key 不一致

readFileState 的三個寫入點用不同的 key 格式：

- `WL8`（memory 載入）：原始路徑，不經 `t4()` 正規化
- `Read tool`（X24）：`t4(path)` 正規化後的路徑
- `Write/Edit tool`：`t4(path)` 正規化後的路徑

在 Windows 上 `t4()` 的 `.normalize("NFC")` 和路徑解析可能改變路徑字串，導致同一個檔案有兩筆 entry。stale check 遍歷到原始 key 時觸發，但更新寫到正規化 key → 原始 key 永遠不被更新 → 無限循環。

### 根因 2：mtime 精度 race condition

```
Claude Edit 寫檔 → readFileState.set(path, {timestamp: oS(path)})  // mtime = T1
→ Stop hook 觸發
→ 在 Claude 結束和下一輪 stale check 之間，
   某個外部程序（IDE autosave、linter、git hook）touch 了檔案 → mtime 變成 T3
→ stale check: oS(path) = T3 > T1 → 觸發！
```

Windows NTFS 的 mtime 精度是 100ns，但 JS `Date.now()` 是 ms。如果 Edit 和 timestamp 記錄在同一個 ms 內完成，mtime <= timestamp → 不觸發。反之則觸發。

### 根因 3：stale check 不更新原始 entry

`jqY` 偵測到變更後只回傳 diff，**不更新** readFileState 的原始 key entry。內部 Read（`KY.call`）會用 `t4()` 正規化路徑更新，但如果原始 key ≠ 正規化 key，原始 entry 的 content 和 timestamp 永遠停留在舊值。

---

## 7. CLI vs Agent SDK 的運作差異

### 白話版

- **CLI**：readFileState 表只在 session 開始時建一次，之後整個 session 共用。如果 Read 更新的 key 剛好跟原始 key 一樣，就能停止注入；運氣不好就停不下來。
- **Agent SDK**：每次建立新的 conversation context 時，readFileState 可能被 clone 或重建，memory 載入（WL8）重新掃描 → 用原始路徑 key 寫入 → `offset: undefined` → 即使上一輪用 Read 修好了，這一輪表被重建又從頭來過。所以每一輪都會注入，Read 多少次都沒用。

### 技術細節

| | CLI 互動模式 | Agent SDK / 無頭模式 |
|---|---|---|
| readFileState 生命週期 | 整個 session 共用一份，活到 session 結束 | 每次建立 conversation context 可能被 clone 或重建 |
| CLAUDE.md/MEMORY.md 載入 | session 開始載入一次，之後 `.has()` 檢查不重複加 | 每次初始化都重新載入 → 每次都重新加回「原始路徑」那筆 |
| 結果 | 有時觸發有時不觸發（看 LRU 快取裡有沒有撞 key） | 穩定觸發（因為每輪都重新載入 memory 檔案） |

### Agent Fork 路徑

```javascript
// Agent fork/init:
y = _ !== void 0 ? dl(K.readFileState) : pl(VY6)
// dl = deep clone parent's readFileState (via LRU dump/load)
// pl(100) = new empty LRU cache (max=100)
```

- 有 parent agent → clone parent 的 readFileState
- 沒有 parent → 建空表

不論哪種，WL8 memory 載入都會重新跑一次，用原始路徑 key 加入 entry → `offset: undefined` → 又開始追蹤。

---

## 8. Session Resume 時 readFileState 的還原機制（C26 完整逆向）

### C26 函數完整源碼（反混淆後）

```javascript
// u4 = "Read", Y3 = "Write", Yq = "Edit"
// meY = 10（預設最多重建 10 筆）
// pl(K) = new LRUCache(K)

function C26(messages, cwd, maxEntries = 10) {
  let cache = pl(maxEntries);        // 新的 LRU cache
  let readOps = new Map();           // tool_use_id → t4(path)
  let writeOps = new Map();          // tool_use_id → { filePath: t4(path), content }

  // ── 第一輪：掃描 assistant 訊息，收集 Read 和 Write 的 tool_use ──
  for (let msg of messages) {
    if (msg.type === "assistant" && Array.isArray(msg.message.content)) {
      for (let block of msg.message.content) {

        // 收集 Read（只收「無 offset、無 limit」的完整讀取）
        if (block.type === "tool_use" && block.name === "Read") {
          let input = block.input;
          if (input?.file_path
              && input?.offset === undefined     // ← 帶 offset 的不收
              && input?.limit === undefined) {   // ← 帶 limit 的不收
            readOps.set(block.id, t4(input.file_path, cwd));
          }
        }

        // 收集 Write（用 input.content 作為檔案內容）
        if (block.type === "tool_use" && block.name === "Write") {
          let input = block.input;
          if (input?.file_path && input?.content) {
            writeOps.set(block.id, {
              filePath: t4(input.file_path, cwd),
              content: input.content
            });
          }
        }

        // ⚠️ 不處理 "Edit" — Edit 操作完全不被還原！
      }
    }
  }

  // ── 第二輪：掃描 user 訊息，找 tool_result 配對 ──
  for (let msg of messages) {
    if (msg.type === "user" && Array.isArray(msg.message.content)) {
      for (let block of msg.message.content) {
        if (block.type === "tool_result" && block.tool_use_id) {

          // 配對 Read 的結果
          let readPath = readOps.get(block.tool_use_id);
          if (readPath && typeof block.content === "string") {
            // 清洗 content：
            //   1. 移除 <system-reminder>...</system-reminder>
            //   2. 移除行號前綴（"  123→" 格式）
            let cleaned = block.content
              .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
              .split("\n")
              .map(line => {
                let match = line.match(/^\s*\d+\u2192(.*)$/);  // \u2192 = →
                return match ? match[1] : line;
              })
              .join("\n")
              .trim();

            if (msg.timestamp) {
              cache.set(readPath, {
                content: cleaned,
                timestamp: new Date(msg.timestamp).getTime(),  // ← JSONL 的過去時間
                offset: void 0,    // ← 永遠 undefined
                limit: void 0      // ← 永遠 undefined
              });
            }
          }

          // 配對 Write 的結果
          let writeInfo = writeOps.get(block.tool_use_id);
          if (writeInfo && msg.timestamp) {
            cache.set(writeInfo.filePath, {
              content: writeInfo.content,   // ← 用 Write 的 input.content，不是 tool_result
              timestamp: new Date(msg.timestamp).getTime(),
              offset: void 0,
              limit: void 0
            });
          }
        }
      }
    }
  }

  return cache;
}
```

### sZ6 — 合併函數

C26 重建完後，會透過 `sZ6` 跟現有的 readFileState 合併：

```javascript
function sZ6(newState, existingState) {
  let merged = dl(newState);  // clone newState
  for (let [path, entry] of existingState.entries()) {
    let existing = merged.get(path);
    if (!existing || entry.timestamp > existing.timestamp) {
      merged.set(path, entry);  // 較新的 timestamp 勝出
    }
  }
  return merged;
}
```

### C26 的四個關鍵問題

**1. Edit 操作完全被忽略**

C26 只處理 `Read`（無 offset/limit）和 `Write`，**不處理 `Edit`**。如果 session 裡大量使用 Edit（這是最常見的修改方式），resume 後那些檔案不會從 C26 進入 readFileState。但它們仍可能透過 WL8 memory 載入（CLAUDE.md/MEMORY.md）或 Claude 重新 Edit 再次進表。

**2. Read 帶預設 offset=1 的也被忽略**

C26 的收集條件是 `offset === undefined && limit === undefined`。但 Read tool 的預設值是 `offset=1`，所以 Claude Code 正常的 Read 呼叫（帶預設 offset=1）不會被 C26 收集。只有極少數明確用 `offset: undefined` 的 Read 才會進表。

**3. 最多 10 筆（Agent SDK）vs 100 筆（CLI）**

| 呼叫位置 | maxEntries | 說明 |
|---|---|---|
| Agent SDK `submitMessage` | `meY = 10` | 每次只重建最多 10 筆 |
| CLI resume（`zA` callback） | `VY6 = 100` | 重建最多 100 筆 |

Agent SDK 的 10 筆限制意味著：如果 session 歷史中有超過 10 個檔案的讀寫操作，LRU 淘汰會讓早期的 entry 消失，但後期的 10 個會留下——全部 `offset: undefined`，全部被追蹤。

**4. timestamp 用 JSONL 的過去時間**

`new Date(msg.timestamp).getTime()` 取的是 JSONL 訊息的記錄時間（過去）。Resume 後檔案的 mtime 幾乎一定比這個時間新 → stale check 的 `oS(path) > timestamp` 幾乎一定成立 → 幾乎一定觸發注入。

### CLI 的 Resume 流程

```
使用者 --resume session_id
  → 載入 JSONL 訊息
  → zA(messages, cwd) 被呼叫
  → C26(messages, cwd, 100)  ← CLI 用 max=100
  → sZ6(K8.current, C26result)  ← 合併到持久的 K8.current（useRef）
  → K8.current 在整個 session 生命週期共用
  → WL8 memory 載入（如果 readFileState 裡沒有 CLAUDE.md/MEMORY.md → 加入）
  → 使用者發訊息
  → jqY stale check：遍歷 readFileState
    → C26 重建的 entry 全部 offset: undefined → 全部被追蹤
    → timestamp 是過去時間 → mtime > timestamp → 觸發
    → 注入 diff（第一輪）
    → 內部 Read 更新正規化 key → 如果 key 一致 → 第二輪不再觸發
    → 如果 key 不一致（路徑 bug）→ 持續觸發
```

### Agent SDK 的 submitMessage 流程

```
每次 submitMessage(userMessage) 被呼叫：

  ┌─ STEP 1：初始建表 ─┐
  │ H6 = { readFileState: C26(this.mutableMessages, K) }
  │ // 從「所有歷史訊息」重建，max=10
  │ // 全部 offset: undefined、timestamp 是過去時間
  └────────────────────┘
          ↓
  ┌─ STEP 2：處理使用者輸入 ─┐
  │ Lu1() → 組裝 user message
  │ 包含 jqY stale check → 此時就已經注入 diff
  │ 包含 WL8 memory 載入 → CLAUDE.md/MEMORY.md 加入表
  └────────────────────────┘
          ↓
  ┌─ STEP 3：再次重建 + 合併 ─┐
  │ K6 = C26(所有訊息含新的, K)   // 又從頭重建
  │ z6 = sZ6(K6, H6.readFileState) // 合併：runtime 更新若 timestamp 更新 → 保留
  │ H6 重建，readFileState = z6
  └────────────────────────────┘
          ↓
  ┌─ STEP 4：主迴圈 ─┐
  │ Claude 回覆、使用工具
  │ Edit/Write 更新 H6.readFileState（runtime）
  └──────────────────┘
          ↓
  下一次 submitMessage → 回到 STEP 1
  // H6 不持久化！readFileState 從 this.mutableMessages 重建
  // 即使 STEP 4 的 runtime 更新修好了 offset，下一輪 STEP 1 又全部重建為 undefined
```

**Agent SDK 的根本問題**：`readFileState` 沒有存在 class property 上（沒有 `this.readFileState`），它是每次 `submitMessage` 的區域變數 `H6`。每次呼叫都從 `this.mutableMessages` 用 C26 全量重建 → 全部 `offset: undefined` → 全部被追蹤 → 每次都注入。

### 自訂檔案（如 memory/2026-03-08.md）

自訂檔案**不會**被 WL8 自動載入，也**不會**被 C26 還原（因為 C26 只處理無 offset 的 Read 和 Write，而大多數 Read 帶預設 offset=1）。

它進入 readFileState 的途徑：

1. **Claude Edit/Write 它** — 最常見。Stop hook 或 CLAUDE.md 指令讓 Claude 寫 memory 檔案 → Edit 成功 → `readFileState.set(path, {offset: undefined})` → 從此被追蹤
2. **被 CLAUDE.md 的 `@include` 引用** — WL8 順著 `@include` 載入
3. **放在 `.claude/rules/` 下** — 被自動掃描載入

重開 CLI 或新一輪 Agent SDK 時的流程：
```
新 session → readFileState 空 → 2026-03-08.md 不在表裡
→ 使用者發訊息 → Claude 回覆
→ Stop hook：「檢查有沒有該記的」
→ Claude Edit memory/2026-03-08.md  ← 這一刻進表了
→ readFileState.set(path, {offset: undefined})  ← 永遠追蹤
→ 使用者發下一則訊息
→ stale check → mtime 比對 → 注入 diff
```

---

## 9. 隱藏機制：為什麼使用者看不到

| 隱藏機制 | 效果 |
|---|---|
| `isMeta: !0` flag | UI 層完全隱藏，使用者在介面看不到 |
| JSONL 不記錄 | Session 檔案裡找不到，事後分析看不到 |
| `NEVER mention this reminder` | Claude 被指示不主動揭露 |
| LaunchDarkly feature flags | 服務端控制，使用者無法關閉 |
| Runtime 動態注入 | 只存在於 API request，不落地 |

唯一能觀察到的方式：
1. **mitmproxy** — 抓 API request 的實際內容（[#17601](https://github.com/anthropics/claude-code/issues/17601) 的方法）
2. **直接問 Claude** — 有時 Claude 會違反 `NEVER mention` 指令揭露
3. **Token 消耗異常** — 間接推斷

---

## 10. 已知 Bug 彙整

### Bug 1：路徑 key 不一致（根因級）

- **位置**：`WL8` vs `X24` / Write tool
- **問題**：WL8 用原始路徑作為 key，Read/Write tool 用 `t4()` 正規化路徑。同一檔案可能有兩筆 entry。
- **影響**：stale check 的原始 key entry 永遠不被更新 → 無限注入

### Bug 2：stale check 不更新 readFileState（根因級）

- **位置**：`jqY` 函數
- **問題**：偵測到 stale 後只回傳 diff，不更新原始 key 的 content 和 timestamp
- **影響**：每輪都重新偵測到「變更」→ 每輪都注入

### Bug 3：C26 重建全部設 offset: undefined

- **位置**：`C26` 函數
- **問題**：Session resume 重建的 entry 全部 `offset: undefined` → 全部被追蹤；timestamp 用過去時間 → 幾乎一定比 mtime 舊
- **影響**：Session resume 後幾乎必定觸發大量注入

### Bug 4：Edit/Write 後 offset 設為 undefined

- **位置**：Write/Edit tool 的 `.set()` 呼叫
- **問題**：Edit/Write 後的 readFileState entry 的 offset 和 limit 都是 `undefined` → stale check 永遠追蹤
- **影響**：Claude 自己改過的檔案從此被永遠追蹤。而 Read tool 的預設 offset=1 反而能「修復」（因為 offset !== undefined → 跳過）

---

## 11. 緩解方案

### 方案對照表

| 方案 | 效果 | 成本 | 適用場景 |
|---|---|---|---|
| CLAUDE.md 加忽略指令 | 中（不穩定） | 低 | 所有場景的基線 |
| **JSONL 預處理** | **高（根治 resume 注入）** | **中** | **CLI resume / Agent SDK** |
| 讓 agent 主動 re-read 檔案 | 中 | 消耗額外 Read token | session 內檔案不多時 |
| Memory 檔寫到 cwd 外面 | 高（根治） | 架構調整 | 有 memory 寫入的專案 |
| 避免讓 CLI 工具修改大檔案（改用 MCP tool） | 高 | 架構調整 | 有大 JSON/config 的專案 |
| 短 session + 頻繁 compact | 中 | 增加 session 管理複雜度 | 互動模式 |
| Cozempic daemon | 中 | 安裝第三方工具 | CLI 互動模式 |
| 直接用 Claude API 不走 CC CLI | 高 | 重寫 orchestration | Agent SDK / 生產環境 |
| 等官方加 `--no-system-reminders` | 最高 | 等 | [#9769](https://github.com/anthropics/claude-code/issues/9769)... |

---

### JSONL 預處理方案（完整實作規格）

#### 背景與原理

C26 從 JSONL 重建 readFileState 時，掃描條件非常具體：

1. **Read**：`block.name === "Read"` 且 `input.offset === undefined && input.limit === undefined`
2. **Write**：`block.name === "Write"` 且 `input.file_path && input.content`
3. **不處理 Edit**

只要讓 JSONL 中的 tool_use 不符合這些條件，C26 就不會建出任何 entry → readFileState 為空 → 不觸發 file modification 注入。

> **Agent SDK 注意**：經實際查驗 `@anthropic-ai/claude-agent-sdk`（v0.2.70），`initialMessages`、`mutableMessages`、`submitMessage` 都是 `cli.js` 內部實作，**不是公開 API**。SDK 的 V1（`query` + `resume`）和 V2（`unstable_v2_resumeSession`）恢復 session 時都是內部讀 JSONL → 跑 C26。使用者無法直接控制 initialMessages，因此 Agent SDK 的處理方式跟 CLI 一樣——**在 resume 前修改 JSONL 檔案本身**。

#### JSONL 檔案位置

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

##### project-hash 的計算方式

從 `cli.js` 逆向的 `ID()` 函數：

```javascript
// 原始碼（反混淆）
// PvA = 200（最大長度閾值）
function ID(path) {
  let result = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (result.length <= 200) return result;
  let hash = bmK(path);
  return result.slice(0, 200) + "-" + hash;
}

function bmK(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i);
    h = (h << 5) - h + ch;
    h |= 0;  // 轉為 32-bit int
  }
  return Math.abs(h).toString(36);
}
```

規則：
1. 把 cwd 路徑中所有非英數字元（`[^a-zA-Z0-9]`）替換為 `-`
2. 如果結果 ≤ 200 字元，直接使用
3. 如果 > 200 字元，截斷前 200 字元 + `-` + base36 hash

實例：

| cwd | project-hash |
|---|---|
| `F:\_Program\OwnProject\ClaudeCab` | `F---Program-OwnProject-ClaudeCab` |
| `C:\Users\User` | `C--Users-User` |
| `F:\_Program\OwnProject\ClaudeCab\agents\general` | `F---Program-OwnProject-ClaudeCab-agents-general` |

##### session-id

UUID v4 格式，例如 `904e7f94-1ac1-42d9-ab36-9f9a5e9ed708`。

可透過 Agent SDK 的 `sessionId` 選項指定，或從 `ls ~/.claude/projects/<project-hash>/*.jsonl` 列出。

#### 方法 A：破壞 C26 的收集條件（推薦）

給 Read 的 input 加上 offset，移除 Write 的 input.content，讓 C26 的條件不成立。

```python
#!/usr/bin/env python3
"""
sanitize_jsonl.py — 預處理 JSONL 檔案，阻止 C26 重建 readFileState

用法：
  python sanitize_jsonl.py <session-jsonl-path>
  python sanitize_jsonl.py --cwd /path/to/project --session <session-id>
  python sanitize_jsonl.py --cwd /path/to/project --all
"""

import json
import re
import os
import sys
import shutil
from pathlib import Path


def get_project_hash(cwd: str) -> str:
    """計算 Claude Code 的 project-hash 目錄名（逆向自 cli.js 的 ID 函數）"""
    result = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
    if len(result) <= 200:
        return result
    # 超過 200 字元：截斷 + bmK hash
    h = 0
    for ch in cwd:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    h = abs(h)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    b36 = ""
    if h == 0:
        b36 = "0"
    else:
        while h > 0:
            b36 = digits[h % 36] + b36
            h //= 36
    return result[:200] + "-" + b36


def get_jsonl_dir(cwd: str) -> Path:
    """取得 JSONL 所在目錄"""
    home = Path.home()
    project_hash = get_project_hash(cwd)
    return home / ".claude" / "projects" / project_hash


def get_jsonl_path(cwd: str, session_id: str) -> Path:
    """取得特定 session 的 JSONL 路徑"""
    return get_jsonl_dir(cwd) / f"{session_id}.jsonl"


def sanitize_jsonl(jsonl_path: Path, dry_run: bool = False) -> dict:
    """
    預處理 JSONL，破壞 C26 的收集條件。

    原理：
    - C26 收集 Read 的條件：input.offset === undefined && input.limit === undefined
      → 給 Read 加上 offset=1，條件不成立，C26 跳過
    - C26 收集 Write 的條件：input.file_path && input.content
      → 移除 Write 的 input.content，條件不成立，C26 跳過
    - C26 不處理 Edit，不需要動

    Returns: { reads_patched, writes_patched, total_lines }
    """
    if not jsonl_path.exists():
        raise FileNotFoundError(f"JSONL not found: {jsonl_path}")

    stats = {"reads_patched": 0, "writes_patched": 0, "total_lines": 0}
    lines_out = []

    with open(jsonl_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line:
                lines_out.append(line)
                continue

            stats["total_lines"] += 1
            msg = json.loads(line)

            if (msg.get('type') == 'assistant'
                    and isinstance(msg.get('message', {}).get('content'), list)):
                for block in msg['message']['content']:
                    if block.get('type') != 'tool_use':
                        continue

                    # Read: 加 offset=1 讓 C26 條件不成立
                    if (block.get('name') == 'Read'
                            and isinstance(block.get('input'), dict)
                            and block['input'].get('offset') is None):
                        block['input']['offset'] = 1
                        stats["reads_patched"] += 1

                    # Write: 移除 content 讓 C26 條件不成立
                    if (block.get('name') == 'Write'
                            and isinstance(block.get('input'), dict)
                            and 'content' in block['input']):
                        del block['input']['content']
                        stats["writes_patched"] += 1

            lines_out.append(json.dumps(msg, ensure_ascii=False))

    if not dry_run:
        # 備份原始檔案
        backup_path = jsonl_path.with_suffix('.jsonl.bak')
        shutil.copy2(jsonl_path, backup_path)
        # 寫入修改後的內容
        with open(jsonl_path, 'w', encoding='utf-8') as f:
            for line in lines_out:
                f.write(line + '\n')

    return stats


def sanitize_all_sessions(cwd: str, dry_run: bool = False):
    """處理指定專案下的所有 session JSONL"""
    jsonl_dir = get_jsonl_dir(cwd)
    if not jsonl_dir.exists():
        print(f"Project directory not found: {jsonl_dir}")
        return

    jsonl_files = list(jsonl_dir.glob("*.jsonl"))
    # 排除備份檔
    jsonl_files = [f for f in jsonl_files if not f.name.endswith('.bak')]

    print(f"Found {len(jsonl_files)} session(s) in {jsonl_dir}")
    for jsonl_path in jsonl_files:
        session_id = jsonl_path.stem
        stats = sanitize_jsonl(jsonl_path, dry_run=dry_run)
        action = "would patch" if dry_run else "patched"
        print(f"  {session_id}: {action} {stats['reads_patched']} Read + "
              f"{stats['writes_patched']} Write in {stats['total_lines']} lines")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Sanitize Claude Code JSONL to prevent C26 readFileState rebuild")
    parser.add_argument("jsonl_path", nargs="?", help="Direct path to a .jsonl file")
    parser.add_argument("--cwd", help="Project working directory (to compute project-hash)")
    parser.add_argument("--session", help="Session ID (UUID)")
    parser.add_argument("--all", action="store_true", help="Process all sessions for the project")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be changed without modifying files")
    args = parser.parse_args()

    if args.jsonl_path:
        path = Path(args.jsonl_path)
        stats = sanitize_jsonl(path, dry_run=args.dry_run)
        action = "Would patch" if args.dry_run else "Patched"
        print(f"{action}: {stats['reads_patched']} Read + {stats['writes_patched']} Write "
              f"in {stats['total_lines']} lines")
        if not args.dry_run:
            print(f"Backup saved to: {path.with_suffix('.jsonl.bak')}")
    elif args.cwd and args.all:
        sanitize_all_sessions(args.cwd, dry_run=args.dry_run)
    elif args.cwd and args.session:
        path = get_jsonl_path(args.cwd, args.session)
        stats = sanitize_jsonl(path, dry_run=args.dry_run)
        action = "Would patch" if args.dry_run else "Patched"
        print(f"{action}: {stats['reads_patched']} Read + {stats['writes_patched']} Write")
    else:
        parser.print_help()
```

##### 使用方式

```bash
# 直接指定 JSONL 路徑
python sanitize_jsonl.py ~/.claude/projects/F---Program-OwnProject-ClaudeCab/904e7f94.jsonl

# 用 cwd + session id
python sanitize_jsonl.py --cwd "F:\_Program\OwnProject\ClaudeCab" --session 904e7f94-1ac1-42d9-ab36-9f9a5e9ed708

# 處理某專案的所有 session
python sanitize_jsonl.py --cwd "F:\_Program\OwnProject\ClaudeCab" --all

# Dry run（只看不改）
python sanitize_jsonl.py --cwd "F:\_Program\OwnProject\ClaudeCab" --all --dry-run
```

##### 整合到 Agent SDK 工作流

```typescript
import { execSync } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

// 在 resume 前預處理 JSONL
function sanitizeBeforeResume(cwd: string, sessionId: string) {
  execSync(`python sanitize_jsonl.py --cwd "${cwd}" --session ${sessionId}`);
}

// 使用
const sessionId = '904e7f94-1ac1-42d9-ab36-9f9a5e9ed708';
sanitizeBeforeResume(process.cwd(), sessionId);

const result = query({
  prompt: 'continue working',
  options: {
    cwd: process.cwd(),
    resume: true,
    sessionId: sessionId,
  }
});
```

#### 方法 B：修改 timestamp 為未來時間

讓 C26 建表但 timestamp 在未來 → `mtime <= timestamp` → stale check 不觸發。

```python
def patch_timestamps(jsonl_path: Path, dry_run: bool = False) -> dict:
    """
    將 JSONL 中所有 user 訊息的 timestamp 改為未來時間。

    原理：C26 用 new Date(msg.timestamp).getTime() 作為 entry 的 timestamp。
    如果 timestamp 在未來，stale check 的 oS(path) <= timestamp 就成立 → 跳過。
    """
    import time
    future_ts = int(time.time() * 1000) + 86400000 * 7  # 一週後

    stats = {"patched": 0, "total_lines": 0}
    lines_out = []

    with open(jsonl_path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line:
                lines_out.append(line)
                continue

            stats["total_lines"] += 1
            msg = json.loads(line)

            if msg.get('type') == 'user' and 'timestamp' in msg:
                msg['timestamp'] = future_ts
                stats["patched"] += 1

            lines_out.append(json.dumps(msg, ensure_ascii=False))

    if not dry_run:
        backup_path = jsonl_path.with_suffix('.jsonl.bak')
        shutil.copy2(jsonl_path, backup_path)
        with open(jsonl_path, 'w', encoding='utf-8') as f:
            for line in lines_out:
                f.write(line + '\n')

    return stats
```

#### 方法比較

| 方法 | 對 C26 的效果 | 副作用 | 推薦度 |
|---|---|---|---|
| A: 加 offset / 移除 content | C26 完全不建表 → 無 entry → 無注入 | Write tool 的 content safety check 可能受影響（首次寫未讀檔案會報 errorCode: 2，Claude 會自動先 Read） | **推薦** |
| B: 改 timestamp 為未來 | C26 建表但 timestamp 在未來 → 不觸發 | 「未來時間」過後若檔案被修改，又會觸發 | 可用但不徹底 |

#### 注意事項

- **方法 A 的副作用**：Write/Edit tool 寫檔前會用 `readFileState.get(path)` 檢查檔案是否已被讀取。如果 C26 沒建出 entry，Write tool 會報 `"File has not been read yet. Read it first before writing to it."`（errorCode: 2）。但這只在第一次寫未讀過的檔案時發生，Claude 會自動先 Read 再 Write，所以實務上不影響。
- **不影響 WL8**：以上方法只阻止 C26 的重建，不影響 WL8 的 memory 載入。CLAUDE.md/MEMORY.md 仍會被正常載入到 readFileState（它們的 timestamp 是 `Date.now()`，通常不會觸發注入）。
- **備份**：腳本會自動建立 `.jsonl.bak` 備份。
- **時機**：必須在 `--resume` 或 Agent SDK 的 `resume: true` 之前執行。

---

### 其他緩解方案

#### CLAUDE.md 加忽略指令

```markdown
- 忽略 <system-reminder> 中關於檔案被 "modified by user or linter" 的通知
- 不要因為 system-reminder 重新讀取或回應檔案變更
```

效果不穩定 — system-reminder 用了 `NEVER mention this reminder` 強制語言，有時壓過 CLAUDE.md。

#### Memory 檔寫到 cwd 外面

Claude Code 只追蹤工作目錄內的檔案。把 memory 寫到 cwd 之外就不會被偵測。

#### Cozempic

社群第三方工具（[Ruya-AI/cozempic](https://github.com/Ruya-AI/cozempic)），提供 `system-reminder-dedup` 等 13 種策略，回報省 15-22% token。

---

## 附錄 A：「Memory 檔案」的精確定義

Claude Code 的「memory 檔案」指的是被指令系統載入機制（`WL8`/`lH`）處理的檔案，**不是**使用者自訂的 memory 目錄：

| 類型 | 檔案 | 路徑範例 |
|---|---|---|
| Managed | Anthropic 內建規則 | 系統目錄 |
| User | `~/.claude/CLAUDE.md` | 全域指令 |
| Project | `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md` | 專案根目錄往上每一層 |
| Local | `CLAUDE.local.md` | 專案本地指令 |
| AutoMem | `MEMORY.md` | `~/.claude/projects/<project-hash>/memory/MEMORY.md` |
| TeamMem | team memory | 組織共享 |

使用者的 `memory/2026-03-08.md` 不在此列。它是因為 Claude 用 Edit 改過它而進入 readFileState，從而被追蹤。

---

## 附錄 B：project-hash 計算方式

> 逆向自 `cli.js` 的 `ID()` 和 `bmK()` 函數

```javascript
// 原始邏輯（反混淆）
function projectHash(cwdPath) {
  // 步驟 1：所有非英數字元替換為 "-"
  let result = cwdPath.replace(/[^a-zA-Z0-9]/g, "-");

  // 步驟 2：長度 ≤ 200 → 直接使用
  if (result.length <= 200) return result;

  // 步驟 3：超過 200 → 截斷 + base36 hash
  let h = 0;
  for (let i = 0; i < cwdPath.length; i++) {
    h = (h << 5) - h + cwdPath.charCodeAt(i);
    h |= 0;  // 轉 32-bit signed int
  }
  return result.slice(0, 200) + "-" + Math.abs(h).toString(36);
}
```

Python 版：

```python
import re

def project_hash(cwd: str) -> str:
    result = re.sub(r'[^a-zA-Z0-9]', '-', cwd)
    if len(result) <= 200:
        return result
    h = 0
    for ch in cwd:
        h = ((h << 5) - h + ord(ch)) & 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000
    h = abs(h)
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    b36 = ""
    if h == 0:
        b36 = "0"
    else:
        while h > 0:
            b36 = digits[h % 36] + b36
            h //= 36
    return result[:200] + "-" + b36
```

實際對照：

| cwd | project-hash 目錄名 |
|---|---|
| `F:\_Program\OwnProject\ClaudeCab` | `F---Program-OwnProject-ClaudeCab` |
| `C:\Users\User` | `C--Users-User` |
| `F:\_Program\OwnProject\ClaudeCab\agents\general` | `F---Program-OwnProject-ClaudeCab-agents-general` |

完整 JSONL 路徑範例：
```
C:\Users\User\.claude\projects\F---Program-OwnProject-ClaudeCab\904e7f94-1ac1-42d9-ab36-9f9a5e9ed708.jsonl
```
