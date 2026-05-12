#!/usr/bin/env bash
# Verify the string anchors documented in docs/learning/cli-anchors.md
# still locate features in the current cli.js. Run this after every
# `bun add @anthropic-ai/claude-agent-sdk@latest`.
#
# Output:
#   <anchor>   N hits     (or "MISSING" if the anchor no longer appears)
# Exit code:
#   0 — every anchor found at least once
#   1 — one or more anchors missing → re-grep the area in cli.js, find
#       the new string, and update cli-anchors.md before relying on it

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/node_modules/@anthropic-ai/claude-agent-sdk/cli.js"

if [ ! -f "$CLI" ]; then
  echo "verify-anchors: $CLI not found — run \`bun install\` first" >&2
  exit 2
fi

# All anchors documented in docs/learning/cli-anchors.md. Keep in sync.
ANCHORS=(
  # Hook engine
  '"PreToolUse"'
  '"PostToolUse"'
  '"hook_started"'
  '"hook_progress"'
  '"hook_response"'
  # Tool dispatcher
  '"tool_use"'
  '"tool_use_id"'
  '"tool_progress"'
  'permission_denials'
  '"toolName"'
  'mcp__'
  # Skill invocation
  '"SKILL.md"'
  '"skill_listing"'
  '"Skill"'
  # Session / config
  '"permission-mode"'
)

missing=0
for anchor in "${ANCHORS[@]}"; do
  # macOS BSD grep -c against a single-line minified file behaves
  # oddly; piping through wc -l gives a stable count.
  count=$(grep -o -F -- "$anchor" "$CLI" 2>/dev/null | wc -l | tr -d ' ')
  count=${count:-0}
  if [ "$count" = "0" ]; then
    printf "  %-30s MISSING\n" "$anchor"
    missing=$((missing + 1))
  else
    printf "  %-30s %s hits\n" "$anchor" "$count"
  fi
done

echo
if [ "$missing" -eq 0 ]; then
  echo "verify-anchors: all $((${#ANCHORS[@]})) anchors found"
  exit 0
else
  echo "verify-anchors: $missing anchor(s) missing — re-rev needed" >&2
  exit 1
fi
