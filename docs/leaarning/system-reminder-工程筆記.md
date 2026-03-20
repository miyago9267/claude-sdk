# System-Reminder Diff 注入問題 — 工程筆記

> 逆向版本：`@anthropic-ai/claude-code@2.1.71`
> 完整調查報告見 `system-reminder-調查報告.md`

---

## 問題

Claude Code 在每輪 user message 組裝 API request 時，會偷偷注入被修改過的檔案 diff。這個行為：

- 不顯示在 UI（`isMeta: !0`）
- 不存 JSONL（runtime 動態注入）
- 沒有開關（[#9769](https://github.com/anthropics/claude-code/issues/9769) 開了半年）
- 對 Agent SDK 影響最大：**每輪都注入，Read 多少次都沒用**

---

## 核心機制

### readFileState

LRU Cache（max=100），key 是檔案路徑，value 是 `{ content, timestamp, offset, limit }`。

每輪 user message 時跑 stale check（`jqY`）：

```
遍歷 readFileState 每個 entry:
  1. offset 或 limit 不是 undefined → 跳過（不追蹤）
  2. 檔案 mtime <= timestamp → 跳過（沒變）
  3. 重新讀檔算 diff → diff 為空 → 跳過
  4. 有 diff → 注入 system-reminder
```

### 誰把檔案放進這張表

| 來源 | offset | limit | 會被追蹤？ |
|---|---|---|---|
| Memory 載入（CLAUDE.md/MEMORY.md） | `undefined` | `undefined` | 永遠追蹤 |
| Read tool（預設 offset=1） | `1` | `undefined` | **不追蹤**（offset !== undefined → 跳過） |
| Edit/Write tool | `undefined` | `undefined` | 永遠追蹤 |
| C26 resume 重建 | `undefined` | `undefined` | 永遠追蹤 |

關鍵：**Read 反而安全，Edit/Write 才會中招。**

---

## 為什麼 Agent SDK 每輪都注入

### C26（resume 重建函數）

每次 resume / Agent SDK submitMessage 時，從 JSONL 重建 readFileState：

- 只收集 Read（無 offset/limit）和 Write 的 tool_use — **不處理 Edit**
- 全部設 `offset: undefined` → 全部被追蹤
- timestamp 用 JSONL 的過去時間 → mtime 幾乎一定比它新 → 觸發
- Agent SDK 用 max=10，CLI 用 max=100

### Agent SDK 的致命流程

```
submitMessage() 被呼叫
  → readFileState = C26(this.mutableMessages)  ← 從 JSONL 全量重建，max=10
  → jqY stale check → 注入 diff
  → 主迴圈跑完，Edit/Write 更新了 readFileState
  → 下一次 submitMessage()
  → readFileState = C26(this.mutableMessages)  ← 又從頭重建，之前的更新全丟
  → 永遠注入
```

`readFileState` 不存在 class property 上，是區域變數，每次 submitMessage 都重建。

---

## 解法：JSONL 預處理

### 原理

破壞 C26 的收集條件，讓它建不出 entry：

- Read 的條件：`offset === undefined && limit === undefined` → **給 Read 加 offset=1**
- Write 的條件：`file_path && content` → **移除 Write 的 content**

### JSONL 路徑

```
~/.claude/projects/<project-hash>/<session-id>.jsonl
```

project-hash = cwd 路徑中所有 `[^a-zA-Z0-9]` 替換為 `-`（≤200 字元直接用，>200 截斷加 hash）。

例：`F:\_Program\OwnProject\ClaudeCab` → `F---Program-OwnProject-ClaudeCab`

### 核心邏輯（TypeScript）

```typescript
import { readFileSync, writeFileSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * 計算 Claude Code 的 project-hash 目錄名
 * 逆向自 cli.js 的 ID() + bmK()
 */
function projectHash(cwd: string): string {
  const result = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (result.length <= 200) return result;

  // bmK hash: 簡單的 charCode 迴圈 → base36
  let h = 0;
  for (let i = 0; i < cwd.length; i++) {
    h = (h << 5) - h + cwd.charCodeAt(i);
    h |= 0; // 轉 32-bit signed int
  }
  return result.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

/**
 * 取得 session JSONL 路徑
 * 例：~/.claude/projects/F---Program-OwnProject-ClaudeCab/904e7f94-xxx.jsonl
 */
function getJsonlPath(cwd: string, sessionId: string): string {
  return join(homedir(), '.claude', 'projects', projectHash(cwd), `${sessionId}.jsonl`);
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  id: string;
  input: Record<string, unknown>;
}

interface JsonlMessage {
  type: string;
  message?: {
    content?: Array<ToolUseBlock | Record<string, unknown>>;
  };
  [key: string]: unknown;
}

/**
 * 預處理 JSONL，破壞 C26 的 readFileState 重建條件。
 * 在 resume 前呼叫。
 *
 * C26 收集條件：
 *   Read:  input.offset === undefined && input.limit === undefined
 *   Write: input.file_path && input.content
 *
 * 處理方式：
 *   Read  → 加 offset=1，讓條件不成立
 *   Write → 移除 content，讓條件不成立
 */
function sanitizeJsonl(jsonlPath: string): { reads: number; writes: number } {
  const stats = { reads: 0, writes: 0 };

  // 備份
  copyFileSync(jsonlPath, jsonlPath + '.bak');

  const content = readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').map(line => {
    if (!line.trim()) return line;

    const msg: JsonlMessage = JSON.parse(line);
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) {
      return line;
    }

    for (const block of msg.message!.content) {
      if (block.type !== 'tool_use') continue;
      const b = block as ToolUseBlock;

      if (b.name === 'Read' && b.input && b.input.offset == null) {
        b.input.offset = 1;
        stats.reads++;
      }
      if (b.name === 'Write' && b.input && 'content' in b.input) {
        delete b.input.content;
        stats.writes++;
      }
    }

    return JSON.stringify(msg);
  });

  writeFileSync(jsonlPath, lines.join('\n'), 'utf-8');
  return stats;
}

export { projectHash, getJsonlPath, sanitizeJsonl };
```

### 整合到 Agent SDK

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { sanitizeJsonl, getJsonlPath } from './sanitize-jsonl';

// resume 前呼叫
const jsonlPath = getJsonlPath(process.cwd(), sessionId);
const stats = sanitizeJsonl(jsonlPath);
console.log(`Patched ${stats.reads} Read + ${stats.writes} Write`);

const result = query({
  prompt: 'continue',
  options: { cwd: process.cwd(), resume: true, sessionId }
});
```

### 副作用

- Write tool 首次寫未讀過的檔案會報 `"File has not been read yet"`（errorCode: 2），但 Claude 會自動先 Read 再 Write，實務上不影響。
- 不影響 CLAUDE.md/MEMORY.md 的 memory 載入（WL8），那是另一條路徑。
