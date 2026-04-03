#!/bin/bash
# ─────────────────────────────────────────────────────────────
# postinstall.sh — bun install / npm install 後自動執行
# ─────────────────────────────────────────────────────────────
#
# 對 node_modules/@anthropic-ai/claude-agent-sdk 套用所有 patch：
#   1. sdk.mjs: 5 個 V2 persistent session patch
#
# cli.js 的 5 個 patch 需要 beautify（耗時 2-3 分鐘），
# 所以不在 postinstall 自動執行。請手動：
#   bash scripts/patch.sh
#
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$SCRIPT_DIR/../node_modules/@anthropic-ai/claude-agent-sdk"

# ── 顏色 ──
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { printf "${GREEN}ok${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!!${NC} %s\n" "$1"; }
fail() { printf "${RED}xx${NC} %s\n" "$1"; exit 1; }

# ── 前置檢查 ──
if [[ ! -d "$SDK_DIR" ]]; then
  warn "@anthropic-ai/claude-agent-sdk not found in node_modules, skipping postinstall"
  exit 0
fi

echo "[@miyago/claude-sdk] postinstall: patching sdk.mjs..."

# ── sdk.mjs V2 patches (regex-based, version-agnostic) ──
bun "$SCRIPT_DIR/patch-v2.mjs"

echo ""
ok "postinstall complete"
echo ""
echo "  sdk.mjs: 6 V2 session patches applied"
echo "  cli.js:  no required patches for v0.2.90+"
echo ""
