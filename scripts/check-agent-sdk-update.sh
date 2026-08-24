#!/usr/bin/env bash
set -u

repo_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
cd "$repo_dir" 2>/dev/null || exit 0

command -v node >/dev/null 2>&1 || exit 0
command -v npm >/dev/null 2>&1 || exit 0
[[ -f package.json ]] || exit 0

current_version="$(node -p "require('./package.json').dependencies?.['@anthropic-ai/claude-agent-sdk'] ?? ''" 2>/dev/null)"
[[ -n "$current_version" ]] || exit 0

latest_version="$(npm view @anthropic-ai/claude-agent-sdk version --fetch-retries=0 --fetch-timeout=2500 2>/dev/null)"
[[ -n "$latest_version" ]] || exit 0
[[ "$current_version" == "$latest_version" ]] && exit 0

printf '[claude-sdk] Agent SDK update available: %s -> %s; run `bun run update:agent-sdk`\n' \
  "$current_version" "$latest_version"
