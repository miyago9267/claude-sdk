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

## Phase F — MED action items (one batch)

- [x] F.1 forward `skill_listing` system event → 'Loaded N skills from <path>' status
- [x] F.2 discoverSkills 多讀 frontmatter `model` + `effort`，formatList 顯示 `<m:… · e:…>` chip
- [x] F.3 stringifyToolContent 處理 `image` block → `[image: <media_type>]`，其他未知 type → `[<type>]`
- [x] F.4 (no-op) tool_progress render — Phase C 的 1s tick 已涵蓋；learning doc 提的 dim stdout 屬 hook_progress
- [x] F.5 forwardToolUse 跳過 `Agent` / `Task` — SDKTaskStartedMessage 已 paint `▸ task` 行，避免雙顯
- [x] F.6 `/hooks` slash command — `src/cli/hooks-config.ts` 讀兩處 settings.json + flatten grouped 格式 + formatHooks
- [x] F.7 turn 結束時 surface `permission_denials[]` 為 `Permission denials this turn:` block

199 tests pass (5 new for hooks-config). Binary rebuilt.

## Phase G — LOW housekeeping

- [x] G.1 plugin-prefixed skill ID (`<plugin>:<name>`) — matches cli.js Gt1
- [x] G.2 `scripts/verify-anchors.sh` — anchor count grep + non-zero exit when any anchor goes MISSING after SDK upgrade
- [ ] G.3 skill turn model badge update — skipped; multi-model edge cases (compact running on haiku triggers same path) make this jitter-prone, deferred

200 tests pass (1 new for plugin-prefix). All anchors verified live.
