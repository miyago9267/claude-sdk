#!/bin/bash
# ─────────────────────────────────────────────────────────────
# patch.sh — Beautify + patch cli.js from official SDK
# ─────────────────────────────────────────────────────────────
#
# 從 node_modules 取出官方 cli.js，beautify 後套用 5 個 patch。
# beautify 後的檔案放在 node_modules 內（不進 git）。
#
# 用法：
#   bash scripts/patch.sh          # beautify + patch
#   bash scripts/patch.sh --check  # 只檢查 patch 狀態
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$SCRIPT_DIR/../node_modules/@anthropic-ai/claude-agent-sdk"
CLI_JS="$SDK_DIR/cli.js"
BACKUP="$CLI_JS.bak"

# ── 顏色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { printf "${GREEN}ok${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!!${NC} %s\n" "$1"; }
fail() { printf "${RED}xx${NC} %s\n" "$1"; exit 1; }

# ── 前置檢查 ──
[[ -f "$CLI_JS" ]] || fail "cli.js not found at $CLI_JS — run 'bun install' first"

MODE="${1:-patch}"

# ── Beautify（如果尚未 beautify） ──
LINE_COUNT=$(wc -l < "$CLI_JS" | tr -d ' ')
if [[ "$LINE_COUNT" -lt 1000 ]]; then
  if [[ "$MODE" == "--check" ]]; then
    warn "cli.js needs beautify ($LINE_COUNT lines)"
  else
    echo "Beautifying cli.js ($LINE_COUNT lines -> ~500K lines)..."
    cp "$CLI_JS" "$BACKUP"
    bunx js-beautify "$BACKUP" -o "$CLI_JS" --type js -s 2 -w 120
    NEW_COUNT=$(wc -l < "$CLI_JS" | tr -d ' ')
    ok "Beautified: $LINE_COUNT -> $NEW_COUNT lines"
  fi
else
  ok "cli.js already beautified ($LINE_COUNT lines)"
fi

# ── cli.js Patch 定義 ──
# 這些 patch 需要在 beautify 後的 cli.js 上手動套用。
# 每次 SDK 升級後，用錨點索引 (docs/leaarning/sdk-anchor-index-v76.md)
# 重新定位行號，再手動修改。
#
# Patch 清單：
#   1. Context 溢出安全邊距 1000 -> 200
#   2. 主 Fork Loop 裁剪（只帶最近 5 輪）
#   3. Subagent Fork Context 裁剪（只帶最近 10 則）
#   4. SDK 啟用 Prompt Cache（querySource sdk 也啟用）
#   5. Streaming 失敗不重試（已收到 content 就跳過）

if [[ "$MODE" == "--check" ]]; then
  echo ""
  echo "cli.js patches require manual application after beautify."
  echo "See docs/PATCHES.md for details."
  exit 0
fi

echo ""
echo "cli.js beautified and ready for manual patching."
echo "See docs/PATCHES.md for the 5 patch locations."
echo ""
ok "patch.sh done"
