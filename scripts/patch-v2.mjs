/**
 * patch-v2.mjs — Patch sdk.mjs to enable V2 persistent session
 *
 * 用結構 regex 匹配 minified code，自動偵測被 rename 的變數名。
 * 不依賴特定版本的變數名（Q, $, X, Y, J 等），只依賴表達式結構。
 *
 * 驗證過的版本：v0.2.77, v0.2.90
 *
 * Usage:
 *   bun scripts/patch-v2.mjs          # apply patches
 *   bun scripts/patch-v2.mjs --check  # dry run
 *   bun scripts/patch-v2.mjs --revert # restore backup
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SDK_MJS = resolve(__dirname, '../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
const BACKUP = SDK_MJS + '.bak'

const mode = process.argv[2] === '--check' ? 'check'
           : process.argv[2] === '--revert' ? 'revert'
           : 'patch'

// ── Revert ──
if (mode === 'revert') {
  if (!existsSync(BACKUP)) { console.error('xx No backup'); process.exit(1) }
  copyFileSync(BACKUP, SDK_MJS)
  console.log('ok Reverted')
  process.exit(0)
}

if (!existsSync(SDK_MJS)) {
  console.error('xx sdk.mjs not found:', SDK_MJS)
  process.exit(1)
}

let code = readFileSync(SDK_MJS, 'utf-8')

// ── Regex escape helper ──
function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── Step 1: Detect options variable name ──
// Anchor: "Cannot send to closed session" is inside SDKSession class.
// Then find `resume:VAR.resume,settingSources:[]` to extract the var name.
// [\w$] covers minifier identifiers including $ and _
const resumeMatch = code.match(/resume:([\w$]{1,3})\.resume,settingSources:\[\]/)
if (!resumeMatch) {
  // Maybe already patched? Check for settingSources:VAR.settingSources
  const patchedMatch = code.match(/resume:([\w$]{1,3})\.resume,settingSources:([\w$]{1,3})\.settingSources/)
  if (patchedMatch) {
    console.log('  [info] Detected options var from patched code:', patchedMatch[1])
  } else {
    console.error('FATAL: Cannot detect SDKSession options variable')
    console.error('  Searched for: resume:VAR.resume,settingSources:[]')
    process.exit(1)
  }
}
const O = resumeMatch?.[1]
  ?? code.match(/resume:([\w$]{1,3})\.resume,settingSources:([\w$]{1,3})\.settingSources/)?.[1]
console.log(`  [info] options var: ${O}`)

// ── Step 2: Detect ProcessTransport internal var names ──
// Scope to SDKSession constructor area (near "Cannot send to closed session")
// to avoid matching V1 query builder which has the same field names
const anchor = code.indexOf('Cannot send to closed session')
if (anchor < 0) { console.error('FATAL: SDKSession anchor not found'); process.exit(1) }
const scope = code.slice(Math.max(0, anchor - 3000), anchor + 3000)
const transportMatch = scope.match(
  /pathToClaudeCodeExecutable:([\w$]{1,3}),env:([\w$]{1,3})/
)
if (!transportMatch) {
  console.error('FATAL: Cannot detect ProcessTransport var names in SDKSession scope')
  process.exit(1)
}
const EXE = transportMatch[1]
const ENV = transportMatch[2]
console.log(`  [info] transport vars: exe=${EXE} env=${ENV}`)

// ── Patch definitions ──
const eO = esc(O)
const eEXE = esc(EXE)
const eENV = esc(ENV)

const patches = [
  {
    id: 'settingSources',
    desc: 'V2 session 載入 CLAUDE.md/MEMORY.md',
    find: new RegExp(`resume:${eO}\\.resume,settingSources:\\[\\]`),
    patched: new RegExp(`resume:${eO}\\.resume,settingSources:${eO}\\.settingSources`),
    replace: () => `resume:${O}.resume,settingSources:${O}.settingSources??[]`,
  },
  {
    id: 'cwd',
    desc: 'V2 session 指定 cwd',
    find: new RegExp(
      `\\({abortController:this\\.abortController,pathToClaudeCodeExecutable:${eEXE},env:${eENV}`
    ),
    patched: new RegExp(`\\({cwd:${eO}\\.cwd,abortController:this\\.abortController`),
    replace: () =>
      `({cwd:${O}.cwd,abortController:this.abortController,pathToClaudeCodeExecutable:${EXE},env:${ENV}`,
  },
  {
    id: 'thinkingConfig+extraArgs',
    desc: 'V2 session 支援 thinking/turns/budget',
    find: /extraArgs:\{\},thinkingConfig:void 0,maxTurns:void 0,maxBudgetUsd:void 0/,
    patched: new RegExp(`extraArgs:${eO}\\.extraArgs`),
    replace: () =>
      `extraArgs:${O}.extraArgs??{},thinkingConfig:${O}.thinkingConfig,maxTurns:${O}.maxTurns,maxBudgetUsd:${O}.maxBudgetUsd`,
  },
  {
    id: 'mcpServers',
    desc: 'V2 session CLI-side MCP servers',
    find: new RegExp(`mcpServers:\\{\\},strictMcpConfig:!1,canUseTool:!!${eO}`),
    patched: new RegExp(`mcpServers:\\(\\(\\)=>`),
    replace: () =>
      `mcpServers:(()=>{if(!${O}.mcpServers)return{};let r={};for(let[k,v]of Object.entries(${O}.mcpServers))if(!v||v.type!=="sdk")r[k]=v;return r})(),strictMcpConfig:!1,canUseTool:!!${O}`,
  },
  {
    id: 'sdkMcpMap+initConfig',
    desc: 'SDK MCP routing + systemPrompt',
    find: new RegExp(
      `${eO}\\.hooks,this\\.abortController,new Map\\),this\\.query\\.streamInput`
    ),
    patched: new RegExp(
      `${eO}\\.hooks,this\\.abortController,\\(\\(\\)=>`
    ),
    replace: () =>
      `${O}.hooks,this.abortController,(()=>{let m=new Map;if(${O}.mcpServers)for(let[k,v]of Object.entries(${O}.mcpServers))if(v&&v.type==="sdk"&&"instance" in v)m.set(k,v.instance);return m})(),void 0,{systemPrompt:${O}.systemPrompt,appendSystemPrompt:${O}.appendSystemPrompt},void 0),this.query.streamInput`,
  },
  {
    id: 'stderr',
    desc: 'stderr callback 傳入 ProcessTransport',
    find: new RegExp(`env:${eENV},executable:${eO}\\.executable`),
    patched: new RegExp(`env:${eENV},stderr:${eO}\\.stderr,executable:${eO}\\.executable`),
    replace: () => `env:${ENV},stderr:${O}.stderr,executable:${O}.executable`,
  },
]

// ── Apply ──
let applied = 0, skipped = 0, missing = 0

for (const p of patches) {
  if (p.patched.test(code) && !p.find.test(code)) {
    console.log(`  [skip] #${p.id} -- already patched`)
    skipped++
    continue
  }

  if (!p.find.test(code)) {
    console.error(`  [MISS] #${p.id} -- pattern not found`)
    console.error(`         regex: ${p.find.source.slice(0, 80)}`)
    missing++
    continue
  }

  if (mode === 'check') {
    console.log(`  [todo] #${p.id} -- ${p.desc}`)
    applied++
    continue
  }

  code = code.replace(p.find, p.replace())

  if (!p.patched.test(code)) {
    console.error(`  [FAIL] #${p.id} -- verification failed`)
    missing++
    continue
  }

  console.log(`  [done] #${p.id} -- ${p.desc}`)
  applied++
}

if (missing > 0) {
  console.error(`\n${missing} patch(es) failed -- sdk.mjs NOT modified`)
  process.exit(1)
}

if (mode === 'check') {
  console.log(`\n${applied} pending, ${skipped} already applied`)
  process.exit(0)
}

if (applied === 0) {
  console.log('\nAll patches already applied')
  process.exit(0)
}

copyFileSync(SDK_MJS, BACKUP)
writeFileSync(SDK_MJS, code, 'utf-8')
console.log(`\n${applied} applied, ${skipped} skipped. Backup: ${BACKUP}`)
