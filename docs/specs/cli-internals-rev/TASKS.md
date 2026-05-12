# Tasks — Phase E

## E.1 hook outcome enum

- [x] `src/cli/tui.ts` — hook_response 改讀 `outcome` 欄位
- [x] 移除 `!stderr || stderr.trim().length === 0` 推斷
- [x] 加 `cancelled` 狀態（colWarning + ⊘ glyph 區別於 err 的 ✗）

## E.2 hook durationMs self-compute

- [x] `hookStartedAt: Map<string, number>` keyed by hook_id
- [x] hook_started 寫入 `Date.now()`，hook_response diff
- [x] response 後 delete entry 避免 leak

## E.3 mcp name parser

- [x] `parseMcpToolName` helper exported，含 join rest
- [x] 6 unit tests cover standard / __-in-tool-name / null cases
- [x] forwardToolUse mcp__ 分支改用 helper

## E.4 Skill row flip

- [x] `EvtAssistantEnd` 加 sweep：所有 `kind==toolKindSkill && !done` 的 entry flip 成 ok
- [x] 註解指向 docs/learning/cli-internals-skill-invocation.md §3

## 收尾

- [x] `bun test src/` 194 pass
- [x] `bash scripts/build-tui.sh` 通過
