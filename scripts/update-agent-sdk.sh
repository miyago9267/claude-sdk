#!/usr/bin/env bash
set -euo pipefail

package_name='@anthropic-ai/claude-agent-sdk'
latest_version="$(npm view "$package_name" version)"
current_version="$(node -p "require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk']")"

if [[ "$current_version" == "$latest_version" ]]; then
  printf 'agent SDK is already up to date: %s\n' "$current_version"
  exit 0
fi

printf 'updating agent SDK: %s -> %s\n' "$current_version" "$latest_version"
bun add "$package_name@$latest_version"

# The old 0.2.x binary patches were removed during the 0.3.x migration.
# Keep this phase as the stable seam for future source-level compatibility work.
bun install --frozen-lockfile
bun test src/

build_dir="$(mktemp -d "${TMPDIR:-/tmp}/claude-sdk-build.XXXXXX")"
bun build src/index.ts --target bun --outdir "$build_dir" >/dev/null

printf 'agent SDK update verified: %s\n' "$latest_version"
