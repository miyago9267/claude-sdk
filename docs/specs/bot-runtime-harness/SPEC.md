---
id: spec-bot-runtime-harness
title: Bot Runtime Harness
status: in_progress
created: 2026-08-21
updated: 2026-08-24
author: Miyago
approved_by:
tags:
  - agent-bot
  - harness
  - runtime
  - orchestration
priority: high
---

# Bot Runtime Harness

## Purpose

把本 repo 從「Claude client / protocol wrapper」定位成可長期運作的
agent-bot runtime substrate，目標產品形態接近 OpenClaw 或 Hermes Agent：

- bot 能接收外部事件並持續維持自己的 identity、session 與 memory。
- bot 能處理即時訊息、cron、webhook、heartbeat 與 background job。
- bot 能被限制工具、權限、workspace、網路、預算與執行時間。
- bot 能在 crash、timeout、rate limit 或 process restart 後恢復。
- bot 能把執行狀態與結果送回不同 channel，而不把 channel UX 寫死在 SDK。

## Scope

### In scope

- Agent run envelope 與事件模型。
- Durable session registry 與 session lifecycle。
- Run supervisor、queue、timeout、retry、cancellation 與 recovery。
- Tool policy、approval routing、audit 與 execution boundary。
- Event bus 與外部 delivery contract。
- Scheduler、cron、heartbeat 與 isolated jobs。
- Memory provider contract 與 memory write policy。
- Bot manifest、workspace bootstrap、skills 與 tool profile。
- Multi-agent delegation orchestration。
- Usage、cost、trace、audit 與 operational observability。
- Provider/model routing 與 fallback policy。
- OpenAI/Ollama 等 protocol adapter 的 runtime integration。

### Out of scope

- 重做官方 Agent SDK 的 agent loop。
- 重做官方 built-in tools、MCP、subagents 或 permission primitives。
- 建立第二套 Claude Code client、REPL 或 TUI。
- 將 Telegram、Discord、Slack 等 channel implementation 硬塞進 core SDK。
- 一開始就建立完整的 multi-provider abstraction。
- 以自有 binary patch 修改官方 SDK bundled runtime。

## Current baseline

官方 `@anthropic-ai/claude-agent-sdk` 目前提供本 project 需要的核心 agent
能力，包括 `query()`、streaming input、built-in tools、MCP、agents、hooks、
permissions、resume/fork、compact、usage/cost、budget 與 execution options。

目前 repo 已有：

- 官方 SDK re-export。
- `ContextManager`：watermark、dynamic context、compact、handoff、restart、
  keepalive 與 rapid-refill breaker。
- persistent session adapter：將 `query()` 包成 `send / stream / close`。
- cumulative usage diff。
- model router、context pruner、token tracker、cache optimizer、optimized
  query wrapper。
- Ollama/OpenAI protocol bridge。
- in-memory history-keyed session pool。
- Phase 1 runtime foundation：run envelope、runtime event bus、file-backed session
  registry、per-session locking、run supervisor、idempotency、retry、timeout、
  cancellation 與 graceful shutdown。
- Phase 2 bot identity foundation：JSON bot manifest、workspace bootstrap loader、
  fail-closed tool policy、approval callback、SDK options builder，以及 supervisor
  的 per-bot/per-user concurrency 與 run budget guard。
- Phase 3 scheduler foundation：file-backed job store、one-shot/interval schedule、
  pause/resume/trigger/remove/edit、manual tick、可停止 process driver 與
  supervisor integration。
- Phase 3 scheduler completion slice：UTC 5-field cron、heartbeat active window、
  per-job isolated session，以及 delivery target execution。
- Phase 3 memory foundation：scope-isolated in-memory/Markdown providers with
  explicit search、write、forget API。
- Durable audit foundation：event-bus recorder、append-only JSONL store、run
  filtering 與 sensitive-field redaction。
- Config compatibility foundation：provider-neutral `RuntimeConfig`、read-only
  Codex TOML import、layer precedence 與 unsupported/override diagnostics。
- Config mapping foundation：supported fields map to Claude SDK options and
  explicit runtime policy inputs with fail-closed privilege handling。
- Delivery foundation：channel-independent `DeliveryRouter`、lifecycle events
  與 in-memory adapter；實際 channel adapter 仍由外部整合層提供。
- CI/CD Agent SDK update 與 SessionStart version check。

目前缺少 durable bot runtime；`SessionPool` 只能當 bridge cache，不能當正式的
bot session store。

## Architecture

```text
External events
  message / cron / webhook / heartbeat / job
              |
              v
       Event ingress + normalization
              |
              v
        Run Supervisor / Queue
          |       |       |
          |       |       +-- Scheduler
          |       +---------- Policy / Approval
          +------------------ Session Registry
                              |
                              v
                    Official Agent SDK query()
                    loop / tools / MCP / agents
                              |
              +---------------+----------------+
              |                                |
              v                                v
       Event stream / audit              Memory provider
              |
              v
       Channel / protocol delivery
```

## Requirements

### R1. Run envelope

每次 bot execution 必須有可追蹤的 `runId`，並記錄：

- `botId`、`sessionId`、trigger type。
- source platform、account、channel、thread、message identity。
- parent run / child run relationship。
- queued、running、completed、failed、cancelled 狀態。
- start、finish、timeout、retry 與 cancellation timestamps。
- model、provider、workspace、policy profile 與 budget snapshot。

同一個外部事件必須可透過 idempotency key 去重。

### R2. Session registry

Session registry 必須能：

- 依 bot、user、channel、thread 與 custom scope 建立 session key。
- 保存官方 session id 與 application metadata。
- resume、fork、reset、archive、expire session。
- 對同一 session 提供 lock，避免 concurrent turn 破壞 conversation state。
- 在 process restart 後恢復 metadata，並能判斷 session 是否需要重建。
- 支援 persistent store interface，第一版可提供 SQLite 或 filesystem adapter。

### R3. Run supervisor

Supervisor 必須能：

- 將 inbound event 轉成可執行 run。
- 控制 per-bot、per-user 與 global concurrency。
- 提供 timeout、cancellation、graceful shutdown 與 orphan cleanup。
- 對可重試錯誤使用 backoff，避免重試不可重試的 permission 或 validation error。
- 保存 run state，讓 process restart 後能 recover 或明確標記 abandoned。
- 支援 foreground run 與 background run。
- 對每個 run 套用 model、tool、workspace、network 與 budget policy。

### R4. Policy and approval

Policy layer 必須包住官方 `canUseTool`、hooks 與 permission options，而不替代
它們。Policy decision 至少支援：

- allow。
- deny。
- ask-human。
- allow-once。
- allow-for-session。
- require-sandbox。

Policy scope 至少包含 bot、user、source channel、job type、workspace、tool
category、risk level 與 environment。

高風險操作，例如 production deploy、credential access、外部訊息發送、
destructive filesystem operation，必須可要求 approval 並留下 audit record。

### R5. Event and delivery contract

Runtime 必須產生穩定、與 channel 無關的事件：

```text
run.queued
run.started
assistant.delta
tool.started
tool.progress
tool.completed
permission.requested
approval.received
run.completed
run.failed
run.cancelled
delivery.queued
delivery.sent
delivery.failed
```

Delivery adapter 負責把結果轉成 Telegram、Discord、Slack、HTTP、OpenAI 或
Ollama 等外部格式。Core runtime 不得依賴特定 channel UI。

### R6. Scheduler, cron and heartbeat

Scheduler 必須支援：

- one-shot 與 recurring schedule。
- pause、resume、edit、trigger、remove。
- missed-run、catch-up 與 duplicate tick policy。
- job timeout、retry、lock 與 graceful shutdown。
- isolated session 與 per-job workspace。
- per-job model、skills、tools、policy、delivery target。
- script / no-agent job，不需要每次都啟動 LLM。
- job output delivery。
- job chaining 與前一個 job output 傳遞。
- heartbeat 與一般 cron 的不同觸發語意。

### R7. Memory

Memory 必須是 provider interface，不在 core 綁定單一 vector database。至少
支援以下 scope：

- conversation memory。
- user memory。
- bot memory。
- workspace memory。
- episodic task memory。
- curated long-term memory。

Memory provider 必須提供 search、write、forget 與 scope isolation。Memory write
必須經過 policy，避免把 secrets、prompt injection、未驗證推論或工具輸出直接
寫入 long-term memory。

第一版可先提供 Markdown/filesystem provider，對應 `MEMORY.md` 與 daily notes。

### R8. Bot manifest and workspace bootstrap

每個 bot 必須能以 manifest 描述：

- identity、model、provider、workspace。
- system prompt 與 bootstrap files。
- skills 與 tool profile。
- memory provider 與 scope。
- policy、approval 與 budget。
- default channel delivery。
- scheduler permissions。

Bootstrap 應能載入 `AGENTS.md`、`CLAUDE.md`、skills 與 bot-specific instructions，
但必須明確區分 trusted configuration 與 untrusted workspace content。

### R9. Multi-agent orchestration

官方 SDK 負責 child agent 的執行；本 harness 負責：

- parent / child run relationship。
- delegation request、timeout、cancel 與 result routing。
- background delegation completion event。
- child session、workspace、tool、budget 與 policy isolation。
- result aggregation 與 partial failure handling。
- parent 對 child 的 status / progress visibility。
- human escalation。

### R10. Execution isolation

Harness 必須提供 execution boundary 的統一設定與檢查，優先重用官方
sandbox/worktree primitives：

- filesystem read/write allowlist。
- workspace 或 git worktree isolation。
- network egress policy。
- subprocess timeout、memory 與 process limits。
- secret injection 與 redaction。
- destructive operation approval。
- production environment hard gate。

### R11. Observability and audit

每個 run 應可查詢：

- end-to-end timeline 與 latency。
- model、provider、token、cost 與 cache usage。
- assistant、tool、permission、approval、retry、error events。
- memory read/write。
- delivery status。
- policy decision 與 decision reason。
- parent / child run graph。

初期可使用 structured JSONL 或 SQLite；API 必須不依賴特定 storage。

### R12. Provider and model routing

目前簡單的 task category router 應逐步支援：

- capability matching。
- cost ceiling。
- latency preference。
- rate-limit backoff。
- provider/model fallback。
- auth profile rotation。
- per-job override。
- routing decision audit。

第一階段只需把 Anthropic models 做好，不急著抽象化所有 provider。

### R13. Cross-runtime configuration compatibility

Runtime config 必須能 read-only import Codex `config.toml` 與 Claude
`settings.json`，但不能把任一 runtime 的 client-only 設定硬塞進 core。

- 定義 provider-neutral `RuntimeConfig` 作為 canonical runtime input。
- 提供 source adapter 與明確 precedence：defaults、imported config、project
  config、bot manifest、per-run override。
- Codex adapter 至少支援 `model`、`model_reasoning_effort`、`sandbox_mode`、
  `approval_policy` 與 environment；無法等價映射的 plugins、TUI、status line
  必須產生 unsupported diagnostic。
- 讀取 Codex config 時不得寫回、改寫或注入 Claude 專用欄位。
- 高風險設定不得靜默放寬：例如 `danger-full-access` 不得自動等同
  Claude `bypassPermissions`。
- Config resolver 必須能回報來源、override 與 unsupported diagnostics，讓
  bot host 決定是否 fail-fast。

## Decisions

- **官方 SDK 是 brain，不重做 loop。**
  - **Reason:** 官方已提供 loop、tools、MCP、agents、permissions 與 hooks。
  - **By:** Miyago (2026-08-21)
- **Harness 是 runtime control plane。**
  - **Reason:** Bot product 的缺口在 session、job、policy、state、delivery 與
    operations，而不是模型 turn execution。
  - **By:** Miyago (2026-08-21)
- **Core 不內建 channel UX。**
  - **Reason:** 同一 runtime 應能服務 messaging、HTTP、protocol adapter 與
    internal worker。
  - **By:** Miyago (2026-08-21)
- **先做 durable orchestration，再擴充 optimize utilities。**
  - **Reason:** 現有 optimize utilities 有一部分與新版 SDK 重疊；bot runtime
    的高風險缺口是 job、session、policy 與 recovery。
  - **By:** Miyago (2026-08-21)
- **Memory 先做 provider contract 與 Markdown backend。**
  - **Reason:** 先驗證 bot workflow，不提前綁定向量資料庫或特定 retrieval stack。
  - **By:** Miyago (2026-08-21)
- **Cross-runtime config 使用 adapter，不共用 runtime 設定檔 schema。**
  - **Reason:** Codex TOML 與 Claude JSON 的 client semantics 不同；read-only
    import 可以共用可攜設定，避免互相污染與錯誤 privilege mapping。
  - **By:** Miyago (2026-08-24)
- **Provider-neutral `RuntimeConfig` 是 runtime 的 canonical input。**
  - **Reason:** Bot manifest、project config 與 per-run override 需要同一個
    precedence 與 conflict model，不能直接讓 caller 依賴 Codex 或 Claude 欄位。
  - **By:** Miyago (2026-08-24)

## Delivery phases

### Phase 1: Runtime foundation

- [x] Define `RunEnvelope`, status transitions and idempotency contract。
- [x] Define initial runtime event schema and event bus。
- [x] Build file-backed session registry with per-session locking。
- [x] Build run supervisor with timeout, retry, cancellation and graceful shutdown。
- [x] Add durable structured run audit storage。
- [x] Add targeted tests for idempotency, concurrent turns, timeout and recovery paths。

### Phase 2: Policy and bot identity

- [x] Define JSON bot manifest and workspace bootstrap。
- [x] Implement tool policy decision model with wildcard and scoped rules。
- [x] Wire policy into SDK `canUseTool` through `buildBotOptions`。
- [x] Add approval request / response interface with fail-closed fallback。
- [x] Add workspace containment check for bootstrap files and environment/sandbox policy inputs。
- [x] Add per-bot and per-user concurrency limits plus run budget guard。

### Cross-runtime configuration compatibility

- [x] Define provider-neutral `RuntimeConfig` and source diagnostics。
- [x] Implement read-only Codex TOML adapter。
- [x] Implement precedence resolver for imported config、project config、bot
  manifest 與 per-run override。
- [x] Map supported config into SDK options and runtime policy with fail-closed
  privilege handling。
- [x] Add conflict、unsupported-field、read-only 與 precedence tests。

### Phase 3: Automation and memory

- [x] Define scheduler and job persistence model。
- [x] Implement one-shot and interval recurring jobs。
- [x] Implement pause/resume/trigger/remove and supervisor integration。
- [x] Add UTC 5-field cron expression parser。
- [x] Implement isolated job sessions and delivery target execution。
- [x] Add heartbeat semantics with optional UTC active window。
- [x] Define `MemoryProvider` and scope model。
- [x] Implement Markdown/filesystem memory provider with explicit write API and scope isolation。

### Phase 4: Multi-agent and delivery

- [ ] Define parent/child delegation events。
- [ ] Implement background delegation and result routing。
- [ ] Add partial failure, timeout and budget propagation。
- [x] Define generic channel delivery contract and router。
- [ ] Implement concrete channel delivery adapters。
- [ ] Keep OpenAI/Ollama bridge on the generic delivery contract。

### Phase 5: Production hardening

- [ ] Add provider/model fallback and rate-limit handling。
- [ ] Add sandbox/worktree adapters and resource limits。
- [ ] Add queryable traces, metrics and audit export。
- [ ] Add crash recovery and abandoned-run repair tooling。
- [ ] Review and remove optimize utilities replaced by official SDK features。

## Existing files and expected future areas

### Existing implementation

- `src/index.ts` - official SDK and harness public exports。
- `src/context-manager.ts` - context lifecycle and usage semantics。
- `src/shared/query-session.ts` - persistent session adapter。
- `src/shared/messages.ts` - generic conversation/message transformations。
- `src/ollama/` - OpenAI/Ollama protocol bridge and in-memory session pool。
- `src/optimize/` - routing, pruning, cache, token and optimized query utilities。
- `src/runtime/` - Phase 1 run, event, session and supervisor foundation。
- `src/runtime/policy.ts` - tool policy evaluation and approval callback adapter。
- `src/runtime/bots.ts` - bot manifest, workspace bootstrap and SDK options builder。
- `src/runtime/config/` - provider-neutral config contract, adapters and resolver。
- `src/runtime/scheduler.ts` - persistent scheduler、cron/heartbeat、isolated job session and delivery execution。
- `src/runtime/cron.ts` - UTC 5-field cron parser and next-occurrence calculation。
- `src/runtime/memory.ts` - scoped memory provider contract and in-memory/Markdown implementations。
- `src/runtime/delivery.ts` - channel-independent delivery contract, router and in-memory adapter。

### Planned modules

- `src/runtime/events.ts` - normalized inbound/outbound event contract。
- `src/runtime/audit.ts` - event recorder, append-only JSONL store and redaction。
- `src/runtime/runs.ts` - run envelope and state machine。
- `src/runtime/supervisor.ts` - queue, concurrency, timeout and recovery。
- `src/runtime/sessions.ts` - durable session registry and locking。
- `src/runtime/policy.ts` - tool, environment and approval policy。
- `src/runtime/delivery.ts` - channel-independent delivery interface。
- `src/runtime/scheduler.ts` - future scheduler extensions such as catch-up policy and job chaining。
- `src/runtime/memory.ts` - memory provider and scope contract。
- `src/runtime/bots.ts` - bot manifest and workspace bootstrap。
- `src/runtime/delegation.ts` - parent/child orchestration。
- `src/runtime/observability.ts` - traces, audit and metrics。

`src/runtime/` currently contains `types.ts`, `events.ts`, `audit.ts`,
`sessions.ts`, `supervisor.ts`, `policy.ts`, `bots.ts`, `scheduler.ts`,
`cron.ts`, `memory.ts`, `delivery.ts` and `index.ts`. The remaining paths are
planning targets, not a commitment to preserve the exact module layout during
implementation.

Phase 2 limitations: policy decisions are currently in-memory, approval has no
durable request store or timeout queue, bootstrap documents are returned as
untrusted workspace content rather than automatically merged into a system
prompt, and manifest concurrency values still require the host to pass matching
supervisor limits.

Delivery limitations: the router only selects adapters and emits lifecycle events;
it does not implement Telegram、Discord、Slack or HTTP transports.

Audit limitations: default redaction is key-based and protects common secret
fields; arbitrary secret values embedded in free-form text require a caller
provided redaction layer before persistence.

Config compatibility limitations: the current mapping emits explicit SDK options
and runtime policy inputs, but automatic merging into `BotManifest` is still
caller-owned. Claude `settings.json` adapter and provider fallback remain future
work; `danger-full-access` intentionally stays sandboxed with an unsafe diagnostic.

Phase 3 limitations: cron uses UTC 5-field expressions only and scheduler does not
yet provide missed-run/catch-up policy, job chaining or script-only jobs. Memory
providers require explicit writes, have no automatic extraction or consolidation,
and do not yet include write-policy enforcement or vector search。

## Acceptance criteria

The first usable bot runtime must be able to:

1. Receive an external event and create one idempotent run。
2. Resolve a bot manifest, workspace, policy and session。
3. Serialize concurrent turns for the same session。
4. Run the official Agent SDK with configured tools and permissions。
5. Stream normalized progress and final events to a delivery adapter。
6. Persist enough state to recover after process restart。
7. Enforce timeout, cancellation, budget and approval decisions。
8. Execute a scheduled isolated job and deliver its result。
9. Record a queryable audit trail without storing secrets by default。
10. Run the same runtime through a protocol adapter or a messaging adapter。

## Non-goals for the first implementation

- Full OpenClaw-compatible channel matrix。
- Full Hermes-compatible tool catalog。
- Vector search or autonomous memory consolidation。
- Distributed multi-region scheduler。
- Automatic self-modifying skills。
- Replacing the official Agent SDK's tools or permission semantics。

## References

- [OpenClaw agent runtime](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent.md)
- [OpenClaw capabilities](https://docs.openclaw.ai/)
- [Hermes Agent architecture and toolsets](https://github.com/NousResearch/hermes-agent/blob/main/AGENTS.md)
- [Hermes scheduled tasks](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/cron.md)
- [Current SDK migration timeline](../../SDK-TIMELINE.md)
