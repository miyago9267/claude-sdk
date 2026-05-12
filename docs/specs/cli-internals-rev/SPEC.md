# CLI Internals Reverse Engineering

## What

對 `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` (12.5M minified) 做三條
deep-dive trace，產出 `docs/learning/cli-internals-*.md`：

1. **Tool Dispatcher** — 一次 tool_use 從 LLM response 到 tool_result 寫回
   conversation 的完整路徑，含 permission gate / canUseTool callback / mcp /
   skill 三條分流。
2. **Hook Engine** — `~/.claude/hooks/*.sh` 跟 settings.json 內 hook 配置怎麼
   被 9 種 hook event (PreToolUse / PostToolUse / Stop / ...) 觸發，stdout /
   stderr 怎麼回到 SDKHook*Message + jsonl 的 `hook_success` 等 record。
3. **Skill Invocation** — `Skill` 內建 tool 跟 `<dir>/SKILL.md` frontmatter
   的關係，skill_listing record 何時寫入，skill body 怎麼進 system prompt。

## Why

User 點對：tool dispatch + hook + skill 是 agentic harness 最核心的三條主線。
沒這層理解，之前做的 Phase D (canUseTool picker)、Phase C (hook surface)、
ollama bridge 的 tool routing 都是 surface-level guess。

## Scope

- **不**重做 cli.js 任何邏輯
- **不**修改 SDK
- 純文檔產出，每個 doc 內含：
  - Anchor strings → 在 minified 的位置
  - 局部 deobfuscated code snippet（簡化版，附最小變數重命名）
  - Lifecycle / sequence diagram（純文字 ascii）
  - 我們既有實作怎麼對應 / 哪裡有缺口
  - Open questions 留給後續驗證

## Method

按 `reverse-engineering` skill 規範：
1. anchor strings → grep cli.js → 取 ±2KB context
2. 順著 single-letter 變數 hop，把關鍵 function 重畫
3. 跟 sdk.d.ts 的 type 對齊
4. 寫成 progressive disclosure 的 markdown

## Out of Scope

- 全 cli.js deobfuscate (太大)
- Permission rule engine 的細節（之後另開）
- Sub-agent / Task tool 內部（另開）
- IDE bridge / chrome integration / cloud（無關）

## Deliverables

- `docs/learning/cli-internals-tool-dispatch.md`
- `docs/learning/cli-internals-hook-engine.md`
- `docs/learning/cli-internals-skill-invocation.md`
- 本 SPEC + 一份 INDEX 整合所有 anchor 在 docs/learning/cli-anchors.md
