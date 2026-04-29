# Tasks

## Layer 1: OpenAI Adapter

- [x] `src/openai/types.ts` - OpenAI ChatCompletion request/response 型別
- [x] `src/openai/transform.ts` - SDK ↔ OpenAI 訊息轉換純函式
- [x] `src/openai/transform.test.ts` - transform unit test (17 tests)
- [x] `src/openai/server.ts` - Hono server (`/v1/chat/completions`, `/v1/models`, `/health`)
- [x] `src/openai/index.ts` - exports

## Layer 2: CLI Harness

- [x] `src/cli/args.ts` - 輕量 argv 解析
- [x] `src/cli/args.test.ts` - argv unit test (10 tests)
- [x] `src/cli/runner.ts` - 一次性 pipe 模式
- [x] `src/cli/repl.ts` - 互動 REPL（整合 ContextManager）
- [x] `src/cli/bin.ts` - shebang entry，dispatch oneshot/repl/serve
- [x] `src/cli/index.ts` - programmatic exports

## 整合

- [x] `package.json` - 加 `hono` dep, `bin: claude-sdk`, `exports./openai`, `exports./cli`, version 1.3.0
- [x] `README.md` - 加上兩層的 quick start
- [x] `bun test` 全綠（30 tests）
- [x] 手動測：`curl /health` 和 `curl /v1/models` OK；`claude-sdk --help` OK

## Layer 2.5: Bubbletea TUI

- [x] `cmd/tui/main.go` - bubbletea model + view（header / viewport / input / footer）
- [x] `cmd/tui/ipc.go` - NDJSON 編解碼 + event schema
- [x] `cmd/tui/go.mod` - bubbletea 1.3.10 + bubbles 0.21 + lipgloss 1.1
- [x] `scripts/build-tui.sh` - go build → `bin/claude-sdk-tui`
- [x] `src/cli/tui.ts` - TS 端 spawn binary，雙向 NDJSON pipe，重用 ContextManager
- [x] `src/cli/args.ts` + `src/cli/bin.ts` - `--tui` flag dispatch
- [x] `bin/` 加進 .gitignore；package.json `files` 包 `cmd/tui/` 與 build script
- [x] README 加 TUI 段落 + build 指引
