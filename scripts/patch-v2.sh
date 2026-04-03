#!/bin/bash
# patch-v2.sh — Thin wrapper around patch-v2.mjs
# Usage: bash scripts/patch-v2.sh [--check|--revert]
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun "$SCRIPT_DIR/patch-v2.mjs" "$@"
