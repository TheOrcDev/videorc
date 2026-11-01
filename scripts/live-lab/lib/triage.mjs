import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { SENSITIVE_PATTERNS } from './card-state.mjs'
import { processAlive, readRunLock } from './run-lock.mjs'
import { REPO_ROOT } from './schedule-table.mjs'

// Plan 178 U12 (owner decision D8). After `live:publish`, a headless Claude
// Code run reads one run folder and says what it sees; the wrapper here posts
// its comments. The boundary, in order of strength:
//
//   1. The agent gets no command tool at all (`--tools Read,Glob,Grep`), so
//      it cannot start a stream, run git or gh, ssh, curl or edit anything by
//      shell. The git log of the harness clone and the issue threads it needs
//      are gathered by this wrapper and put in the prompt.
//   2. `--disallowedTools` removes Edit/Write/NotebookEdit/WebFetch/WebSearch/
//      Agent/Skill/Bash and every MCP tool on the command line, independent
//      of any settings file being accepted.
//   3. `config/live-lab/claude-settings.json` (passed with `--settings`)
//      denies the same tools and the places a secret lives (`~/.videorc-
//      live-lab`, `~/.ssh`, `~/.config`, keychains, dotfiles) for the Read
//      tool, with `defaultMode: dontAsk`; the wrapper adds `--permission-mode
//      dontAsk --permission-prompts none --restricted`, so anything that would
//      prompt is denied, file tools stay inside the run folder and the harness
//      clone, and the lab user's own ~/.claude settings are not loaded.
//   4. The agent never posts: it returns structured JSON, and the wrapper
//      posts one comment per issue that U10 recorded in `published.json`,
//      after the redaction check. An unknown issue number or a body with a
//      key-shaped string is refused and recorded, never posted.
//   5. The child's environment is an allowlist: no lab config, no GH_TOKEN /
//      GITHUB_TOKEN, no Discord or YouTube variables, no VIDEORC_* at all.
//
// Triage never runs while the run lock is held (a run is live) and only when
// the owner's policy says `triage: true`. Nothing here starts a stream.

const execFileAsync = promisify(execFile)

export const TRIAGE_SCHEMA = 1
export const TRIAGED_FILE = 'triaged.json'
export const PUBLISHED_FILE = 'published.json'
export const VERDICT_FILE = 'verdict.json'
export const REPORT_FILE = 'report.md'
export const TRIAGE_DIR = 'triage'
export const ISSUES_REPO = 'TheOrcDev/videorc'
export const SKILL_PATH = join(REPO_ROOT, '.agents', 'skills', 'videorc-live-lab', 'SKILL.md')
export const SETTINGS_PATH = join(REPO_ROOT, 'config', 'live-lab', 'claude-settings.json')
export const TRIAGE_HEADING = '## Triage a run'

export const CLAUDE_TOOLS = Object.freeze(['Read', 'Glob', 'Grep'])
export const DISALLOWED_TOOLS = Object.freeze([
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Skill',
  'mcp__*'
])
export const MAX_TURNS = 40
export const MAX_BUDGET_USD = 5
export const TIMEOUT_MS = 10 * 60 * 1000
export const KILL_GRACE_MS = 10 * 1000
export const COMMENT_MAX_CHARS = 4000
export const GIT_LOG_COMMITS = 40
export const ISSUE_BODY_CHARS = 1200
export const ISSUE_COMMENT_CHARS = 400
export const ISSUE_COMMENTS_KEPT = 3
export const OUTPUT_TAIL_CHARS = 4000

// Exactly these variables reach the child, when set in the parent. Nothing
// that names a lab secret, a GitHub token or a Videorc setting is on the list.
export const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN'
])
export const ENV_PREFIX_ALLOWLIST = Object.freeze(['CLAUDE_CODE_'])
export const ENV_FIXED = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  NO_COLOR: '1',
  CI: '1'
})

// The agent's answer. `--json-schema` makes Claude Code return it as
// `structured_output`; the wrapper also accepts the same JSON as the plain
// result text.
export const RESULT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'comments'],
  properties: {
    summary: { type: 'string', description: 'Two or three sentences on what the run shows.' },
    likelyCauses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['signature', 'why'],
        properties: {
          signature: { type: 'string' },
          commit: { type: 'string', description: 'Short sha from the git log given, if any.' },
          why: { type: 'string' }
        }
      }
    },
    needsEyes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'seen'],
        properties: {
          id: { type: 'string' },
          frame: { type: 'string' },
          seen: { type: 'string', description: 'What is visible in the frame, nothing more.' }
        }
      }
    },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['issue', 'body'],
        properties: {
          issue: { type: 'integer', description: 'An issue number from the list given.' },
          body: { type: 'string', description: 'Markdown, under 4000 characters.' }
        }
      }
    }
  }
})

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`${path} unreadable: ${error.message}`)
  }
}

function tail(text = '', chars = OUTPUT_TAIL_CHARS) {
  return text.length > chars ? text.slice(-chars) : text
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** The child's environment: the allowlist, the fixed values, nothing else. */
export function childEnv(env = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (ENV_ALLOWLIST.includes(key) || ENV_PREFIX_ALLOWLIST.some((p) => key.startsWith(p))) {
      out[key] = value
    }
  }
  return { ...out, ...ENV_FIXED }
}

/** The `claude` argv (without the prompt, which goes in on stdin). */
export function buildClaudeArgs({
  settingsPath = SETTINGS_PATH,
  harnessDir = REPO_ROOT,
  maxTurns = MAX_TURNS,
  maxBudgetUsd = MAX_BUDGET_USD,
  model = null
} = {}) {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(RESULT_SCHEMA),
    '--settings',
    settingsPath,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--restricted',
    '--tools',
    CLAUDE_TOOLS.join(','),
    '--disallowedTools',
    DISALLOWED_TOOLS.join(','),
    '--add-dir',
    harnessDir,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-turns',
    String(maxTurns),
    '--max-budget-usd',
    String(maxBudgetUsd)
  ]
  if (model) args.push('--model', model)
  return args
}

/** Issue numbers U10 recorded in published.json, in every shape it may use. */
export function issueNumbersFrom(published) {
  const numbers = new Set()
  const add = (value) => {
    if (Number.isInteger(value) && value > 0) numbers.add(value)
    else if (typeof value === 'string') {
      const match = /\/issues\/(\d+)(?:[/?#]|$)/.exec(value)
      if (match && value.includes(`/${ISSUES_REPO}/`)) numbers.add(Number(match[1]))
      else if (/^\d+$/.test(value.trim())) numbers.add(Number(value))
    }
  }
  const walk = (entry) => {
    if (entry === null || entry === undefined) return
    if (Array.isArray(entry)) {
      for (const item of entry) walk(item)
      return
    }
    if (typeof entry === 'object') {
      if (typeof entry.repo === 'string' && entry.repo !== ISSUES_REPO) return
      add(entry.number)
      add(entry.issue)
      add(entry.url)
      walk(entry.issues)
      walk(entry.issueNumbers)
      walk(entry.incidents)
      return
    }
    add(entry)
  }
  if (!published || typeof published !== 'object') return []
  walk(published)
  return [...numbers].sort((a, b) => a - b)
}

/** The skill's triage section, from its heading to the next `## ` heading. */
export function triageSection(skillText) {
  const lines = String(skillText ?? '').split('\n')
  const start = lines.findIndex((line) => line.startsWith(TRIAGE_HEADING))
  if (start < 0) throw new Error(`skill has no "${TRIAGE_HEADING}" section`)
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

function list(items, format) {
  return items.length ? items.map(format).join('\n') : '(none)'
}

/** A compact, secret-free text block of the verdict for the prompt. */
export function verdictSummary(verdict) {
  if (!verdict || typeof verdict !== 'object') return '(verdict.json missing or unreadable)'
  const signals = Array.isArray(verdict.signals) ? verdict.signals : []
  const notPass = signals.filter((s) => s && s.status !== 'pass')
  const incidents = Array.isArray(verdict.incidents) ? verdict.incidents : []
  const needsEyes = Array.isArray(verdict.needsEyes) ? verdict.needsEyes : []
  const build = verdict.build ?? {}
  return [
    `run: ${verdict.runId ?? '?'}  scenario: ${verdict.scenario ?? '?'}  trigger: ${verdict.trigger ?? '?'}`,
    `outcome: ${verdict.outcome ?? '?'}  thresholds: ${verdict.thresholdsMode ?? '?'}  privacy: ${verdict.privacy ?? '?'}`,
    `build: ${build.source ?? '?'} ${build.version ?? '?'} (${build.sha ?? '?'})`,
    `window: ${verdict.startedAt ?? '?'} to ${verdict.endedAt ?? '?'}`,
    `signals: ${signals.length} total, ${notPass.length} not pass`,
    list(notPass, (s) => {
      const value =
        s.value !== undefined && s.value !== null ? ` ${s.value}${s.unit ? ` ${s.unit}` : ''}` : ''
      const threshold =
        s.threshold !== undefined && s.threshold !== null ? ` (threshold ${s.threshold})` : ''
      return `  - [${s.status}${s.severity ? ` ${s.severity}` : ''}] ${s.id}:${value}${threshold} ${s.summary ?? ''} evidence: ${(s.evidence ?? []).join(', ') || '-'}`
    }),
    `incidents: ${incidents.length}`,
    list(
      incidents,
      (i) =>
        `  - [${i.severity ?? '?'}] ${i.signature ?? '?'} at ${i.firstAt ?? '?'}: ${i.summary ?? ''} evidence: ${(i.evidence ?? []).join(', ') || '-'}`
    ),
    `needs eyes: ${needsEyes.length}`,
    list(needsEyes, (n) => `  - ${n.id ?? '?'}: ${n.question ?? ''} frame: ${n.frame ?? '-'}`),
    `vod: ${verdict.vod?.url ?? 'unknown'}`,
    `quota: lab ${verdict.quota?.labUnits ?? '?'} units, bundled ${verdict.quota?.bundledUnits ?? '?'} units`
  ].join('\n')
}

/** The prompt. Paths are relative to the run folder (the working directory). */
export function buildPrompt({
  runId,
  skillSection,
  verdictText,
  issues = [],
  gitLog = '',
  files = [],
  harnessDir = '(the harness clone, added with --add-dir)'
}) {
  const issueBlock = issues.length
    ? issues
        .map((issue) => {
          const head = `### #${issue.number} ${issue.title ?? ''}${issue.state ? ` (${issue.state})` : ''}`
          const body = issue.body ? `\n${issue.body}` : ''
          const comments = (issue.comments ?? []).length
            ? `\nRecent comments:\n${issue.comments.map((c) => `- ${c}`).join('\n')}`
            : ''
          return `${head}${body}${comments}`
        })
        .join('\n\n')
    : '(no issues were opened or commented for this run; return an empty comments list)'
  return [
    `You are the live-lab triage for run ${runId}. Follow the skill section below exactly.`,
    '',
    skillSection,
    '',
    '## This run',
    '',
    'The working directory is the run folder. Files in it:',
    list(files, (f) => `- ${f}`),
    '',
    '## Verdict summary (verdict.json)',
    '',
    verdictText,
    '',
    `## Recent commits in the harness clone (${harnessDir}, newest first)`,
    '',
    gitLog.trim() || '(git log unavailable)',
    '',
    `## Issues for this run (${ISSUES_REPO}); comment only on these numbers`,
    '',
    issueBlock,
    '',
    '## Answer',
    '',
    'Return only the JSON object the schema asks for: `summary`, `likelyCauses`,',
    '`needsEyes` (one entry per needs-eyes frame you looked at, describing only what is',
    'visible), and `comments` (at most one per issue number above, under 4000 characters,',
    'no secrets, no file paths outside the run folder, no home paths, no email addresses,',
    'short commit shas only). You cannot run commands, edit files or post anything: the',
    'wrapper posts your comments after a redaction check. Do not ask questions.'
  ].join('\n')
}

/** Parses `claude --output-format json` stdout into the result and the analysis. */
export function parseClaudeResult(stdoutText) {
  let parsed
  try {
    parsed = JSON.parse(String(stdoutText ?? '').trim())
  } catch {
    return { ok: false, error: 'claude printed no JSON result', result: null, analysis: null }
  }
  const result = Array.isArray(parsed)
    ? [...parsed].reverse().find((m) => m && m.type === 'result')
    : parsed
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'no result message in claude output', result: null, analysis: null }
  }
  const summary = {
    subtype: result.subtype ?? null,
    isError: result.is_error === true,
    numTurns: result.num_turns ?? null,
    durationMs: result.duration_ms ?? null,
    costUsd: result.total_cost_usd ?? null,
    sessionId: result.session_id ?? null,
    stopReason: result.stop_reason ?? null,
    permissionDenials: Array.isArray(result.permission_denials)
      ? result.permission_denials.map((d) => ({
          tool: d.tool_name ?? null,
          input: summarizeDenialInput(d.tool_input)
        }))
      : [],
    errors: Array.isArray(result.errors) ? result.errors.map(String) : []
  }
  let analysis = null
  if (result.structured_output && typeof result.structured_output === 'object') {
    analysis = result.structured_output
  } else if (typeof result.result === 'string') {
    const text = result.result
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
    try {
      analysis = JSON.parse(text)
    } catch {
      analysis = null
    }
  }
  if (summary.isError || (summary.subtype && summary.subtype !== 'success')) {
    return {
      ok: false,
      error: `claude ended with ${summary.subtype ?? 'an error'}${summary.errors[0] ? `: ${summary.errors[0]}` : ''}`,
      result: summary,
      analysis
    }
  }
  if (!analysis || typeof analysis !== 'object' || !Array.isArray(analysis.comments)) {
    return { ok: false, error: 'claude returned no structured analysis', result: summary, analysis }
  }
  return { ok: true, error: null, result: summary, analysis }
}

function summarizeDenialInput(input) {
  if (!input || typeof input !== 'object') return null
  const out = {}
  for (const key of ['file_path', 'command', 'url', 'path', 'pattern', 'notebook_path']) {
    if (typeof input[key] === 'string') out[key] = input[key].slice(0, 200)
  }
  return Object.keys(out).length ? out : null
}

// Fallback redaction when U9's redact.mjs is not on this checkout: the test
// card's sensitive patterns, replaced by their name. Never the matched text.
export function localRedactText(text) {
  // One pass, earliest match first, so a replacement label is never scanned
  // again (the word "secret" in "[redacted:opaque secret]" is not a hit).
  let out = ''
  let rest = String(text ?? '')
  while (rest.length) {
    let best = null
    for (const { name, pattern } of SENSITIVE_PATTERNS) {
      const match = pattern.exec(rest)
      if (match && (best === null || match.index < best.index)) {
        best = { name, index: match.index, length: Math.max(match[0].length, 1) }
      }
    }
    if (!best) {
      out += rest
      break
    }
    out += `${rest.slice(0, best.index)}[redacted:${best.name}]`
    rest = rest.slice(best.index + best.length)
  }
  return out
}

export function localFindSensitive(text) {
  const hits = []
  const value = String(text ?? '')
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    const match = pattern.exec(value)
    if (match) hits.push({ pattern: name, index: match.index })
  }
  return hits
}

/** U9's redact.mjs when present, else the local guard. */
export async function loadRedactor({ importer = (s) => import(s) } = {}) {
  try {
    const mod = await importer('./redact.mjs')
    if (typeof mod.redactText === 'function' && typeof mod.findSensitive === 'function') {
      return { redactText: mod.redactText, findSensitive: mod.findSensitive, source: 'redact.mjs' }
    }
  } catch {
    // fall through to the local guard
  }
  return { redactText: localRedactText, findSensitive: localFindSensitive, source: 'local' }
}

/** The posted comment: a fixed header, the agent's body, a fixed footer. */
export function commentBody({ runId, outcome, body }) {
  return [
    `**Live lab triage** for run \`${runId}\` (outcome: ${outcome ?? 'unknown'}). Automated, headless; read-only on the lab machine (plan 178 U12).`,
    '',
    body.trim(),
    '',
    '_One comment per run. Fixes go through the normal plan / PR flow._'
  ].join('\n')
}

/**
 * Pure: which comments may be posted. An unknown issue, an empty or oversize
 * body, a second comment for the same issue, or any sensitive hit is refused
 * with a reason. The returned bodies are the final text to post.
 */
export function validateComments(analysis, { allowedIssues, findSensitive, runId, outcome }) {
  const seen = new Set()
  const out = []
  for (const raw of Array.isArray(analysis?.comments) ? analysis.comments : []) {
    const issue = Number.isInteger(raw?.issue) ? raw.issue : Number(raw?.issue)
    const entry = {
      issue: Number.isInteger(issue) ? issue : null,
      ok: false,
      reason: null,
      body: null
    }
    if (!entry.issue || !allowedIssues.includes(entry.issue)) {
      entry.reason = 'issue not in published.json'
    } else if (seen.has(entry.issue)) {
      entry.reason = 'duplicate comment for this issue'
    } else if (typeof raw.body !== 'string' || raw.body.trim().length < 20) {
      entry.reason = 'body missing or too short'
    } else if (raw.body.length > COMMENT_MAX_CHARS) {
      entry.reason = `body over ${COMMENT_MAX_CHARS} characters`
    } else {
      const body = commentBody({ runId, outcome, body: raw.body })
      const hits = findSensitive(body)
      if (hits.length) {
        entry.reason = `redaction: ${hits.map((h) => h.pattern).join(', ')}`
      } else {
        entry.ok = true
        entry.body = body
      }
    }
    if (entry.issue) seen.add(entry.issue)
    out.push(entry)
  }
  return out
}

/** Run folders with published.json and no triaged.json, oldest first. */
export async function findRunsToTriage({ runsDir, since = null }) {
  let names = []
  try {
    names = await readdir(runsDir)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY
  const found = []
  for (const name of names.sort()) {
    const dir = join(runsDir, name)
    try {
      if (!(await stat(dir)).isDirectory()) continue
    } catch {
      continue
    }
    if (!(await exists(join(dir, PUBLISHED_FILE)))) continue
    if (await exists(join(dir, TRIAGED_FILE))) continue
    if (Number.isFinite(sinceMs)) {
      const published = await readJson(join(dir, PUBLISHED_FILE))
      const stamp = Date.parse(published?.publishedAt ?? published?.at ?? '')
      if (Number.isFinite(stamp) && stamp < sinceMs) continue
    }
    found.push(dir)
  }
  return found
}

/** May triage run now? Policy says so, the run lock is free, nothing is live. */
export async function checkCanTriage({ workDir, policy, problems = [], isAlive = processAlive }) {
  if (!policy) return { ok: false, reason: `policy invalid: ${problems[0] ?? 'missing'}` }
  if (policy.triage !== true) return { ok: false, reason: 'policy.triage is not true' }
  const lock = await readRunLock({ dir: workDir })
  if (lock?.corrupt) return { ok: false, reason: `run lock unreadable (${lock.reason})` }
  if (lock && isAlive(lock.pid)) {
    return { ok: false, reason: `run lock held (${lock.runId}, pid ${lock.pid}); a run is live` }
  }
  return { ok: true, reason: null }
}

/** `git log` of the harness clone, formatted for the prompt (no author, no email). */
export async function harnessGitLog({
  harnessDir = REPO_ROOT,
  exec = execFileAsync,
  count = GIT_LOG_COMMITS
}) {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', harnessDir, 'log', `--max-count=${count}`, '--date=short', '--format=%h %ad %s'],
      { maxBuffer: 1024 * 1024 }
    )
    return stdout.trim()
  } catch (error) {
    return `(git log failed: ${tail(error.message, 200)})`
  }
}

/** Issue title, body excerpt and recent comments through `gh issue view --json`. */
export async function fetchIssue(number, { exec = execFileAsync, repo = ISSUES_REPO } = {}) {
  try {
    const { stdout } = await exec(
      'gh',
      [
        'issue',
        'view',
        String(number),
        '--repo',
        repo,
        '--json',
        'number,title,state,body,comments'
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    const issue = JSON.parse(stdout)
    const comments = Array.isArray(issue.comments) ? issue.comments : []
    return {
      number,
      title: issue.title ?? '',
      state: issue.state ?? '',
      body: String(issue.body ?? '').slice(0, ISSUE_BODY_CHARS),
      comments: comments.slice(-ISSUE_COMMENTS_KEPT).map((c) =>
        String(c?.body ?? '')
          .replace(/\s+/g, ' ')
          .slice(0, ISSUE_COMMENT_CHARS)
      )
    }
  } catch (error) {
    return {
      number,
      title: '',
      state: '',
      body: `(gh issue view failed: ${tail(error.message, 200)})`,
      comments: []
    }
  }
}

export async function postComment({
  number,
  body,
  exec = execFileAsync,
  repo = ISSUES_REPO,
  bodyFile
}) {
  await exec('gh', ['issue', 'comment', String(number), '--repo', repo, '--body-file', bodyFile], {
    maxBuffer: 1024 * 1024
  })
}

/**
 * Spawns `claude` with the prompt on stdin, the allowlisted env and the run
 * folder as cwd. Resolves { code, signal, stdout, stderr, timedOut }.
 */
export function invokeClaude({
  args,
  prompt,
  cwd,
  env,
  timeoutMs = TIMEOUT_MS,
  spawnFn = spawn,
  claudeBin = 'claude',
  onChild = () => {}
}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let child
    try {
      child = spawnFn(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout,
        stderr: `spawn failed: ${error.message}`,
        timedOut
      })
      return
    }
    onChild(child)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref?.()
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk) => (stderr = tail(stderr + chunk.toString(), 64 * 1024)))
    child.on('error', (error) => {
      stderr += `spawn failed: ${error.message}\n`
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      onChild(null)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(prompt)
  })
}

/**
 * Triages one run folder and writes triaged.json. `deps` are injectable for
 * tests; nothing here is ever called with a real `claude` in tests.
 */
export async function triageRun({
  runDir,
  harnessDir = REPO_ROOT,
  settingsPath = SETTINGS_PATH,
  skillPath = SKILL_PATH,
  env = process.env,
  now = () => new Date(),
  dryRun = false,
  deps = {}
}) {
  const invoke = deps.invoke ?? invokeClaude
  const exec = deps.exec ?? execFileAsync
  const redactor = deps.redactor ?? (await loadRedactor())
  const log = deps.log ?? (() => {})
  const runId = basename(runDir)
  const startedAt = now().toISOString()
  const record = {
    schema: TRIAGE_SCHEMA,
    runId,
    startedAt,
    endedAt: null,
    status: 'error',
    reason: null,
    redaction: redactor.source,
    issues: [],
    claude: null,
    analysis: null,
    comments: []
  }
  const finish = async (status, reason = null) => {
    record.status = status
    record.reason = reason
    record.endedAt = now().toISOString()
    const text = redactor.redactText(JSON.stringify(record, null, 2))
    if (!dryRun) await writeFile(join(runDir, TRIAGED_FILE), `${text}\n`, 'utf8')
    return JSON.parse(text)
  }

  const published = await readJson(join(runDir, PUBLISHED_FILE))
  if (!published) return finish('skipped', 'published.json missing')
  const verdict = await readJson(join(runDir, VERDICT_FILE))
  if (!verdict) return finish('skipped', 'verdict.json missing')
  record.issues = issueNumbersFrom(published)

  let skillSection
  try {
    skillSection = triageSection(await readFile(skillPath, 'utf8'))
  } catch (error) {
    return finish('error', error.message)
  }
  if (!(await exists(settingsPath))) return finish('error', 'claude-settings.json missing')

  const files = (await readdir(runDir)).filter((name) => name !== TRIAGED_FILE).sort()
  const issues = []
  for (const number of record.issues) issues.push(await fetchIssue(number, { exec }))
  const prompt = buildPrompt({
    runId,
    skillSection,
    verdictText: verdictSummary(verdict),
    issues,
    gitLog: await harnessGitLog({ harnessDir, exec }),
    files,
    harnessDir: '~/videorc'
  })
  const args = buildClaudeArgs({ settingsPath, harnessDir, model: deps.model ?? null })
  // The record keeps the argv without the schema text (it is RESULT_SCHEMA)
  // and a short prompt hash, so triaged.json stays small and readable.
  const recordedArgs = args.map((arg, index) =>
    args[index - 1] === '--json-schema' ? '(RESULT_SCHEMA)' : arg
  )
  record.claude = {
    args: recordedArgs,
    promptChars: prompt.length,
    promptSha256: sha256(prompt).slice(0, 16)
  }
  if (dryRun) {
    record.prompt = prompt
    record.argv = args
    return finish('dry-run', 'nothing invoked, nothing posted')
  }

  log(`triage ${runId}: claude -p (${record.issues.length} issue(s), ${prompt.length} chars)`)
  const run = await invoke({ args, prompt, cwd: runDir, env: childEnv(env) })
  const parsed = parseClaudeResult(run.stdout)
  record.claude = {
    ...record.claude,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    stderrTail: tail(run.stderr, 2000),
    ...(parsed.result ?? {})
  }
  record.analysis = parsed.analysis
  if (run.timedOut) return finish('error', `claude timed out after ${TIMEOUT_MS / 60000} min`)
  if (!parsed.ok) return finish('error', parsed.error)

  const checked = validateComments(parsed.analysis, {
    allowedIssues: record.issues,
    findSensitive: redactor.findSensitive,
    runId,
    outcome: verdict.outcome
  })
  const triageDir = join(runDir, TRIAGE_DIR)
  await mkdir(triageDir, { recursive: true })
  for (const entry of checked) {
    const out = { issue: entry.issue, posted: false, reason: entry.reason }
    if (entry.ok) {
      const bodyFile = join(triageDir, `comment-${entry.issue}.md`)
      await writeFile(bodyFile, `${entry.body}\n`, 'utf8')
      out.bodySha256 = sha256(entry.body).slice(0, 16)
      try {
        await postComment({ number: entry.issue, body: entry.body, exec, bodyFile })
        out.posted = true
        log(`triage ${runId}: commented on #${entry.issue}`)
      } catch (error) {
        out.reason = `gh issue comment failed: ${tail(error.message, 300)}`
      }
    } else {
      log(`triage ${runId}: comment for #${entry.issue ?? '?'} refused (${entry.reason})`)
    }
    record.comments.push(out)
  }
  const posted = record.comments.filter((c) => c.posted).length
  const refused = record.comments.filter((c) => !c.posted).length
  if (posted) return finish('posted', refused ? `${posted} posted, ${refused} refused` : null)
  if (refused) return finish('refused', `${refused} comment(s) refused`)
  return finish(
    'nothing-to-post',
    record.issues.length ? 'claude returned no comments' : 'no issues for this run'
  )
}

// A model of Claude Code's documented rule evaluation (permissions.md:
// deny, then ask, then allow; prefix `:*` or trailing ` *`; a deny matches
// any subcommand of a compound command; Edit rules cover every file-editing
// tool). It exists so the tests can show what the settings file resolves to
// without a model call. It is NOT the real engine: the real check is owed on
// the lab machine (see the skill section).
export function modelPermission(settings, { tool, command = null, path = null }) {
  const rules = settings?.permissions ?? {}
  const matches = (rule) => {
    const m = /^([A-Za-z_*]+)(?:\((.*)\))?$/.exec(rule)
    if (!m) return false
    const [, ruleTool, spec] = m
    const editFamily = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
    const toolMatches =
      ruleTool === tool ||
      (ruleTool.endsWith('*') && tool.startsWith(ruleTool.slice(0, -1))) ||
      (ruleTool === 'Edit' && editFamily.includes(tool))
    if (!toolMatches) return false
    if (spec === undefined) return true
    if (tool === 'Bash') {
      if (command === null) return false
      const prefix = spec.endsWith(':*')
        ? spec.slice(0, -2)
        : spec.endsWith(' *')
          ? spec.slice(0, -2)
          : null
      const parts = command.split(/\s*(?:&&|\|\||;|\||\n)\s*/)
      return parts.some((part) =>
        prefix === null ? part === spec : part === prefix || part.startsWith(`${prefix} `)
      )
    }
    if (path === null) return false
    return globToRegExp(spec).test(path)
  }
  for (const rule of rules.deny ?? []) if (matches(rule)) return 'deny'
  for (const rule of rules.ask ?? []) if (matches(rule)) return 'ask'
  for (const rule of rules.allow ?? []) if (matches(rule)) return 'allow'
  return 'ask'
}

function globToRegExp(spec) {
  let pattern = spec
  if (pattern.startsWith('//')) pattern = pattern.slice(1)
  else if (pattern.startsWith('~/')) pattern = `/home/lab/${pattern.slice(2)}`
  else if (pattern.startsWith('./')) pattern = `/run/${pattern.slice(2)}`
  else if (!pattern.startsWith('/')) pattern = `**/${pattern}`
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
  return new RegExp(`^${source}$`)
}
