#!/bin/bash
# ─────────────────────────────────────────────────────────────
# patch-v2.sh — Patch sdk.mjs to enable V2 persistent session
# ─────────────────────────────────────────────────────────────
#
# 對 dQ class (SDKSession) constructor 做 5 個 string replacement，
# 讓 unstable_v2_createSession() 接受完整選項。
#
# 原理：dQ 建構 x9 (ProcessTransport) 時把 settingSources、cwd、
# thinkingConfig、mcpServers 等全部硬編碼，導致 V2 session 功能殘缺。
# x9.initialize() 本身已支援所有參數，只是 dQ 沒傳下去。
#
# 基線版本：@anthropic-ai/claude-agent-sdk v0.2.77
# 錨點索引：docs/leaarning/sdk-anchor-index-v76.md
#
# 用法：
#   bash packages/sdk/scripts/patch-v2.sh          # 正常 patch
#   bash packages/sdk/scripts/patch-v2.sh --check   # 只檢查不修改
#   bash packages/sdk/scripts/patch-v2.sh --revert   # 從 .bak 還原
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_MJS="$SCRIPT_DIR/../src/sdk.mjs"
BACKUP="$SDK_MJS.bak"

# ── 顏色 ──
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
fail() { printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

# ── 參數處理 ──
MODE="patch"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ "${1:-}" == "--revert" ]]; then
  MODE="revert"
fi

# ── Revert ──
if [[ "$MODE" == "revert" ]]; then
  if [[ -f "$BACKUP" ]]; then
    cp "$BACKUP" "$SDK_MJS"
    ok "Reverted from backup"
  else
    fail "No backup found at $BACKUP"
  fi
  exit 0
fi

# ── 前置檢查 ──
[[ -f "$SDK_MJS" ]] || fail "sdk.mjs not found: $SDK_MJS"

# ── Patch 定義 ──
# 每個 patch: FIND string → REPLACE string
# 用 bun 做 string replacement（避免 sed 在 minified code 的跳脫問題）

export SDK_MJS MODE

bun -e '
const fs = require("fs");
const path = process.env.SDK_MJS;
const mode = process.env.MODE;

let code = fs.readFileSync(path, "utf-8");
const original = code;

// ── Patch 定義 ──────────────────────────────────────────────
const patches = [
  {
    id: "settingSources",
    desc: "讓 V2 session 載入 CLAUDE.md/MEMORY.md",
    find: "resume:Q.resume,settingSources:[]",
    replace: "resume:Q.resume,settingSources:Q.settingSources??[]",
  },
  {
    id: "cwd",
    desc: "讓 V2 session 在正確的 cwd 工作",
    find: "({abortController:this.abortController,pathToClaudeCodeExecutable:X,env:Y",
    replace: "({cwd:Q.cwd,abortController:this.abortController,pathToClaudeCodeExecutable:X,env:Y",
  },
  {
    id: "thinkingConfig+extraArgs",
    desc: "讓 V2 session 支援 thinking/turns/budget/extraArgs",
    find: "extraArgs:{},thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0",
    replace: "extraArgs:Q.extraArgs??{},thinkingConfig:Q.thinkingConfig,maxTurns:Q.maxTurns,maxBudgetUsd:Q.maxBudgetUsd",
  },
  {
    id: "mcpServers",
    desc: "讓 V2 session 支援 CLI-side MCP servers",
    find: "mcpServers:{},strictMcpConfig:!1,canUseTool:!!Q",
    replace: "mcpServers:(()=>{if(!Q.mcpServers)return{};let r={};for(let[k,v]of Object.entries(Q.mcpServers))if(!v||v.type!==\"sdk\")r[k]=v;return r})(),strictMcpConfig:!1,canUseTool:!!Q",
  },
  {
    id: "g9-sdkMcpMap+initConfig",
    desc: "SDK MCP routing + systemPrompt/appendSystemPrompt 支援",
    find: "Q.hooks,this.abortController,new Map),this.query.streamInput",
    replace: "Q.hooks,this.abortController,(()=>{let m=new Map;if(Q.mcpServers)for(let[k,v]of Object.entries(Q.mcpServers))if(v&&v.type===\"sdk\"&&\"instance\" in v)m.set(k,v.instance);return m})(),void 0,{systemPrompt:Q.systemPrompt,appendSystemPrompt:Q.appendSystemPrompt},void 0),this.query.streamInput",
  },
];

// ── 檢查 & 套用 ────────────────────────────────────────────
let applied = 0;
let skipped = 0;
let missing = 0;

for (const p of patches) {
  const alreadyPatched = code.includes(p.replace) && !code.includes(p.find);
  const canPatch = code.includes(p.find);

  if (alreadyPatched) {
    console.log(`  [skip] #${p.id} — already patched`);
    skipped++;
    continue;
  }

  if (!canPatch) {
    console.error(`  [MISS] #${p.id} — find string not found!`);
    console.error(`         find: ${p.find.slice(0, 80)}...`);
    missing++;
    continue;
  }

  if (mode === "check") {
    console.log(`  [todo] #${p.id} — ${p.desc}`);
    applied++;
    continue;
  }

  code = code.replace(p.find, p.replace);

  // 驗證替換成功
  if (!code.includes(p.replace)) {
    console.error(`  [FAIL] #${p.id} — replacement verification failed`);
    missing++;
    continue;
  }

  console.log(`  [done] #${p.id} — ${p.desc}`);
  applied++;
}

// ── 結果 ────────────────────────────────────────────────────
if (missing > 0) {
  console.error(`\n${missing} patch(es) failed — sdk.mjs NOT modified`);
  process.exit(1);
}

if (mode === "check") {
  console.log(`\n${applied} patch(es) pending, ${skipped} already applied`);
  process.exit(0);
}

if (applied === 0) {
  console.log("\nAll patches already applied, nothing to do");
  process.exit(0);
}

// 備份 & 寫入
fs.copyFileSync(path, path + ".bak");
fs.writeFileSync(path, code, "utf-8");

console.log(`\n${applied} patch(es) applied, ${skipped} skipped`);
console.log(`Backup: ${path}.bak`);
'

# ── 語法驗證 ──
if [[ "$MODE" == "patch" ]]; then
  if node -c "$SDK_MJS" 2>/dev/null; then
    ok "Syntax check passed"
  else
    warn "Syntax check failed — reverting"
    cp "$BACKUP" "$SDK_MJS"
    fail "Patch produced invalid JavaScript, reverted to backup"
  fi
fi

ok "patch-v2.sh done (mode=$MODE)"
