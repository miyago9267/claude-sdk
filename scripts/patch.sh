#!/bin/bash
# Regenerate patched cli.js from official SDK
# Usage: bash packages/sdk/scripts/patch.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OFFICIAL_CLI="$SCRIPT_DIR/../../../node_modules/@anthropic-ai/claude-agent-sdk/cli.js"
OUTPUT_CLI="$SCRIPT_DIR/../src/cli.js"

if [ ! -f "$OFFICIAL_CLI" ]; then
  echo "Error: Official CLI not found at $OFFICIAL_CLI"
  echo "Run 'bun install' first."
  exit 1
fi

echo "Beautifying cli.js..."
bunx js-beautify "$OFFICIAL_CLI" -o "$OUTPUT_CLI" --type js -s 2 -w 120

echo "Applying patches..."
# Patch 1: Cache editing beta
# Patch 2: Subagent fork context
# Patch 3: Streaming fallback
# Patch 4: Context overflow
# (placeholders -- patches will be applied by the CLI agent)

echo "Validating syntax..."
node -c "$OUTPUT_CLI"

echo "Done! Patched cli.js at $OUTPUT_CLI"
