#!/usr/bin/env bash
# Build the bubbletea TUI binary used by `claude-sdk --tui`.
# Output: ./bin/claude-sdk-tui (host platform)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/cmd/tui"
OUT_DIR="$ROOT/bin"
OUT="$OUT_DIR/claude-sdk-tui"

if ! command -v go >/dev/null 2>&1; then
  echo "build-tui: 'go' not found in PATH. Install Go 1.24+ to build the TUI." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$SRC"
go build -ldflags="-s -w" -o "$OUT" .
echo "build-tui: $OUT"
