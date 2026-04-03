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

# ── cli.js Patch 狀態（v0.2.90 逆向結果） ──
#
# v0.2.90 官方修復/架構變更：
#   1. Context 安全邊距 -- 架構完全重寫為多層閾值，舊 patch 無意義。刪除
#   2. 主 Fork Loop 裁剪 -- 官方未修，但 subagent 現在啟動前會 compact。可選保留
#   3. Subagent Context 裁剪 -- 官方加了 compact-before-start。刪除
#   4. SDK Prompt Cache -- 官方已修（sdk 加入 cache-enabled querySource set）。刪除
#   5. Streaming 不重試 -- 官方改為 model fallback。刪除
#
# 結論：cli.js 不再需要常規 patch。
#        如需 fork 裁剪（multi-agent 場景），手動在 beautified cli.js 套用。

if [[ "$MODE" == "--check" ]]; then
  echo ""
  echo "cli.js: No required patches for v0.2.90+"
  echo "  Patch #4 (SDK cache): FIXED by Anthropic"
  echo "  Patch #1/#5: Architecture changed, patches obsolete"
  echo "  Patch #2 (fork pruning): Optional for multi-agent"
  echo "  Patch #3 (subagent pruning): Handled by compact-before-start"
  exit 0
fi

echo ""
echo "cli.js beautified. No required patches for v0.2.90+."
echo "See: docs/leaarning/sdk-reverse-engineering-v90.md"
echo ""
ok "patch.sh done"
