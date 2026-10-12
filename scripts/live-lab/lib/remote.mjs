import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm
} from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { parseArgs } from 'node:util'

import { PRIVACIES } from './policy.mjs'
import { parseBuildSpec } from './install-sources.mjs'
import {
  IMAGE_EXTENSIONS,
  PublishRefused,
  TEXT_EXTENSIONS,
  findLocalSensitive,
  guardFiles,
  sanitizeLine
} from './publish-guard.mjs'

// Plan 178 U10 step 1. `pnpm live:remote` starts an on-demand run on the lab
// machine from any dev machine, over SSH, and copies back only the guarded
// report. Two halves live here:
//
//   local  (remote.mjs --host ...): validates every argument, builds one
//          shell script with every value single-quoted, runs it with
//          `ssh -T -a -x -o BatchMode=yes`, streams the lab's lines back
//          (sanitized), then `scp`s verdict.json, report.md, charts/ and
//          frames/ from RUN_DIR into a staging dir, runs the publish guard,
//          and only then moves them to ~/videorc-live-lab/remote-runs/<runId>.
//   lab    (remote.mjs --lab-side ...): runs on the lab machine from the
//          checked-out harness. For a candidate it checks the policy, the STOP
//          file and the run lock, installs the candidate under the run lock,
//          runs `run.mjs --trigger on-demand` in its own process group (an SSH
//          drop never kills a live run; the lab's kill switches still apply),
//          restores the previous app after a candidate run, optionally
//          publishes, and prints RUN_FILES= / RUN_EXIT= / RUN_DIR= last.
//
// No secret ever goes over the command line: the lab machine holds them all.
// Scenario params travel as JSON in VIDEORC_LIVE_LAB_SCENARIO_PARAMS.
//
// Local exit codes: run.mjs's own 0 / 1 / 2 / 3 (see lib/harness.mjs);
// 4 = the run ended but copying back failed or the guard refused the files;
// 5 = SSH or the lab-side setup failed before a run started.

export const PARAMS_ENV = 'VIDEORC_LIVE_LAB_SCENARIO_PARAMS'
export const MAX_PARAMS_BYTES = 4096
export const DEFAULT_REF = 'origin/main'
export const RUN_ARTIFACTS = Object.freeze(['verdict.json', 'report.md', 'charts', 'frames'])
export const ARTIFACT_DIRS = Object.freeze(['charts', 'frames'])
export const EXIT_COPY_FAILED = 4
export const EXIT_SETUP_FAILED = 5
export const LOCKFILE_MARKER = 'node_modules/.live-lab-lockfile'

const SCENARIO_RE = /^[a-z0-9-]+$/
const REF_RE = /^[A-Za-z0-9._/-]+$/
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/
const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{6}$/
const RUN_DIR_RE = /^\/[A-Za-z0-9._/-]+\/runs\/([^/]+)$/

export class RemoteUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RemoteUsageError'
  }
}

/** POSIX single-quoting: safe for sh, bash and zsh. Refuses NUL and non-strings. */
export function shellQuote(value) {
  if (typeof value !== 'string') throw new TypeError('shellQuote takes a string')
  if (value.includes('\0')) throw new RemoteUsageError('a NUL byte cannot be quoted')
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function validateScenario(value) {
  const text = String(value ?? '')
  if (!SCENARIO_RE.test(text) || text.length > 48 || text.startsWith('-')) {
    throw new RemoteUsageError('--scenario must match ^[a-z0-9-]+$ (48 characters max)')
  }
  return text
}

export function validateRef(value) {
  const text = String(value ?? '')
  if (!REF_RE.test(text) || text.startsWith('-') || text.includes('..') || text.length > 200) {
    throw new RemoteUsageError(
      '--ref must match ^[A-Za-z0-9._/-]+$, not start with "-" or hold ".."'
    )
  }
  return text
}

export function validateHost(value) {
  const text = String(value ?? '')
  if (!HOST_RE.test(text) || text.length > 253) {
    throw new RemoteUsageError('--host must be an ssh host or user@host (letters, digits, . _ @ -)')
  }
  return text
}

/** `release` or `candidate:<run-id|sha>` (U5's parser), normalized; null when absent. */
export function validateBuild(value) {
  if (value === undefined || value === null) return null
  let spec
  try {
    spec = parseBuildSpec(value)
  } catch (error) {
    throw new RemoteUsageError(error.message)
  }
  if (spec.kind === 'release') return { text: 'release', kind: 'release', id: null }
  const id = spec.runId ?? spec.sha
  return { text: `candidate:${id}`, kind: 'candidate', id }
}

export function validatePrivacy(value) {
  if (value === undefined || value === null) return null
  if (!PRIVACIES.includes(value)) {
    throw new RemoteUsageError(`--privacy must be one of ${PRIVACIES.join(', ')}`)
  }
  return value
}

/**
 * Scenario params: a JSON object of at most 4 KB with nothing secret-shaped
 * in it. Returns the normalized JSON text (re-serialized), or null.
 */
export function parseParams(text) {
  if (text === undefined || text === null || text === '') return null
  if (Buffer.byteLength(String(text), 'utf8') > MAX_PARAMS_BYTES) {
    throw new RemoteUsageError(`--params must be at most ${MAX_PARAMS_BYTES} bytes of JSON`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new RemoteUsageError('--params is not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RemoteUsageError('--params must be a JSON object')
  }
  const normalized = JSON.stringify(parsed)
  if (findLocalSensitive(normalized).length > 0) {
    throw new RemoteUsageError('--params looks like it holds a secret; the lab machine holds those')
  }
  return normalized
}

export function parseRemoteArgs(argv) {
  let values
  try {
    values = parseArgs({
      args: argv.filter((arg) => arg !== '--'),
      options: {
        host: { type: 'string' },
        scenario: { type: 'string' },
        build: { type: 'string' },
        privacy: { type: 'string' },
        params: { type: 'string' },
        ref: { type: 'string', default: DEFAULT_REF },
        out: { type: 'string' },
        publish: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    throw new RemoteUsageError(error.message)
  }
  if (values.help) return { help: true }
  return {
    help: false,
    host: validateHost(values.host),
    scenario: validateScenario(values.scenario),
    build: validateBuild(values.build),
    privacy: validatePrivacy(values.privacy),
    paramsJson: parseParams(values.params),
    ref: validateRef(values.ref),
    out: values.out ?? null,
    publish: values.publish
  }
}

export function parseLabSideArgs(argv) {
  let values
  try {
    values = parseArgs({
      args: argv.filter((arg) => arg !== '--'),
      options: {
        'lab-side': { type: 'boolean', default: false },
        scenario: { type: 'string' },
        build: { type: 'string' },
        privacy: { type: 'string' },
        publish: { type: 'boolean', default: false }
      },
      strict: true,
      allowPositionals: false
    }).values
  } catch (error) {
    throw new RemoteUsageError(error.message)
  }
  return {
    scenario: validateScenario(values.scenario),
    build: validateBuild(values.build),
    privacy: validatePrivacy(values.privacy),
    publish: values.publish
  }
}

/** The arguments `remote.mjs --lab-side` gets on the lab (all validated already). */
export function labSideArgs({ scenario, build, privacy, publish }) {
  const args = ['--lab-side', '--scenario', scenario]
  if (build) args.push('--build', build.text)
  if (privacy) args.push('--privacy', privacy)
  if (publish) args.push('--publish')
  return args
}

/**
 * The one shell script the lab runs. Every value is single-quoted, after
 * validation; nothing secret is in it. Dependencies are reinstalled only when
 * the checked-out lockfile differs from the one last installed.
 */
export function buildRemoteScript({ scenario, build, privacy, paramsJson, ref, publish }) {
  const lines = [
    'set -e',
    'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"',
    'cd "$HOME/videorc"',
    'git fetch --quiet origin',
    `git checkout --quiet --detach ${shellQuote(validateRef(ref))}`,
    'want=$(git rev-parse HEAD:pnpm-lock.yaml)',
    `have=$(cat ${LOCKFILE_MARKER} 2>/dev/null || true)`,
    'if [ "$want" != "$have" ]; then',
    '  echo "live:remote: lockfile changed, installing dependencies"',
    '  pnpm install --frozen-lockfile --ignore-scripts',
    `  printf '%s' "$want" > ${LOCKFILE_MARKER}`,
    'fi',
    paramsJson ? `export ${PARAMS_ENV}=${shellQuote(paramsJson)}` : `unset ${PARAMS_ENV}`,
    `exec node scripts/live-lab/remote.mjs ${labSideArgs({ scenario, build, privacy, publish })
      .map(shellQuote)
      .join(' ')}`
  ]
  return `${lines.join('\n')}\n`
}

export const SSH_OPTIONS = Object.freeze([
  '-T',
  '-a',
  '-x',
  '-o',
  'BatchMode=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ServerAliveInterval=30',
  '-o',
  'ServerAliveCountMax=6'
])

/** ssh argv: the remote login shell parses `/bin/sh -c '<script>'`. */
export function buildSshArgs(host, script) {
  return [...SSH_OPTIONS, '--', validateHost(host), `/bin/sh -c ${shellQuote(script)}`]
}

export function buildScpArgs(host, remotePath, localPath, { recursive = false } = {}) {
  return [
    '-q',
    ...(recursive ? ['-r'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'ForwardAgent=no',
    '--',
    `${validateHost(host)}:${remotePath}`,
    localPath
  ]
}

/** Pure: a validated lab RUN_DIR and its run id, or null. */
export function parseRunDir(value) {
  const match = RUN_DIR_RE.exec(String(value ?? '').trim())
  if (!match || !RUN_ID_RE.test(match[1]) || match[0].includes('..')) return null
  return { runDir: match[0], runId: match[1] }
}

/** Pure: folds one lab stdout line into { runDir, runId, files, exitCode }. */
export function readControlLine(line, state) {
  const text = line.trim()
  let match = /^RUN_DIR=(.+)$/.exec(text)
  if (match) {
    const parsed = parseRunDir(match[1])
    if (parsed) Object.assign(state, parsed)
    else state.badRunDir = true
    return 'run-dir'
  }
  match = /^RUN_FILES=(.*)$/.exec(text)
  if (match) {
    state.files = match[1]
      .split(',')
      .map((name) => name.trim())
      .filter((name) => RUN_ARTIFACTS.includes(name))
    return 'run-files'
  }
  match = /^RUN_EXIT=(\d+)$/.exec(text)
  if (match) {
    state.exitCode = Number(match[1])
    return 'run-exit'
  }
  return null
}

/** Spawns a process and hands each output line to a callback. Resolves { code, signal }. */
export function spawnLines(
  file,
  args,
  { onStdout, onStderr, onChild, spawnFn = spawn, ...options } = {}
) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    } catch (error) {
      onStderr?.(`spawn ${file} failed: ${error.message}`)
      resolve({ code: null, signal: null, child: null })
      return
    }
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (l) => onStdout?.(l))
    if (child.stderr) createInterface({ input: child.stderr }).on('line', (l) => onStderr?.(l))
    child.on('error', (error) => onStderr?.(`spawn ${file} failed: ${error.message}`))
    child.on('close', (code, signal) => resolve({ code, signal }))
    onChild?.(child)
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function listFiles(root) {
  const out = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw new Error(`symlink in the copied run (${relative(root, path)})`)
      if (info.isDirectory()) await walk(path)
      else out.push(path)
    }
  }
  await walk(root)
  return out
}

/**
 * Copies the allowed artifacts of a lab run folder into `outDir`, through a
 * staging dir next to it. Every copied file must be a text or PNG file that
 * passes the publish guard; otherwise nothing is kept. Resolves { outDir,
 * files } or throws (PublishRefused for a guard refusal).
 */
export async function copyBack({ host, runDir, runId, files, outDir, scp, redactor }) {
  const parent = dirname(outDir)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (await exists(outDir)) throw new Error(`${runId} was already copied back (output dir exists)`)
  const staging = await mkdtemp(join(parent, `.${runId}.partial-`))
  try {
    for (const name of files) {
      const recursive = ARTIFACT_DIRS.includes(name)
      const result = await scp(
        buildScpArgs(host, `${runDir}/${name}`, join(staging, name), { recursive })
      )
      if (result.code !== 0) throw new Error(`scp of ${name} failed (exit ${result.code})`)
    }
    const copied = await listFiles(staging)
    const allowed = [...TEXT_EXTENSIONS, ...IMAGE_EXTENSIONS]
    const labels = new Map(copied.map((path) => [path, relative(staging, path)]))
    for (const path of copied) {
      if (!allowed.includes(extname(path).toLowerCase())) {
        throw new PublishRefused('REDACTION_FAILED', [
          { file: labels.get(path), pattern: 'file type not allowed' }
        ])
      }
    }
    await guardFiles(copied, { redactor, labels })
    if (copied.some((path) => labels.get(path) === 'verdict.json')) {
      const verdict = JSON.parse(await readFile(join(staging, 'verdict.json'), 'utf8'))
      if (verdict.runId !== runId) throw new Error('verdict.json names another run')
    }
    await chmod(staging, 0o700)
    await rename(staging, outDir)
    return { outDir, files: copied.map((path) => labels.get(path)).sort() }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/**
 * The local half. `ssh(args, { onStdout, onStderr })` and `scp(args)` are
 * injectable runners; `print` / `printErr` take one line. Resolves the exit
 * code (see the header).
 */
export async function runRemote({
  options,
  ssh,
  scp,
  redactor,
  outRoot,
  print = (line) => console.log(line),
  printErr = (line) => console.error(line)
}) {
  const script = buildRemoteScript(options)
  const state = { runDir: null, runId: null, files: null, exitCode: null, badRunDir: false }
  print(
    `live:remote: ${options.scenario} on ${options.host} (harness ${options.ref}${options.build ? `, build ${options.build.text}` : ''})`
  )
  const result = await ssh(buildSshArgs(options.host, script), {
    onStdout(line) {
      const kind = readControlLine(line, state)
      if (kind === 'run-dir') {
        if (state.runId) print(`[lab] run folder runs/${state.runId}`)
        return
      }
      if (kind) return
      print(`[lab] ${sanitizeLine(line)}`)
    },
    onStderr(line) {
      printErr(`[lab] ${sanitizeLine(line)}`)
    }
  })

  if (state.exitCode === null) {
    printErr(
      `live:remote: SETUP_FAILED (ssh or the lab-side setup exited ${result.code ?? result.signal ?? 'unknown'} before a run started)`
    )
    return EXIT_SETUP_FAILED
  }
  const exitCode = state.exitCode
  if (state.badRunDir) {
    printErr('live:remote: COPY_FAILED (the lab printed a RUN_DIR outside the runs folder)')
    return EXIT_COPY_FAILED
  }
  if (!state.runId) {
    print(`live:remote: no run folder (run exit ${exitCode})`)
    return exitCode
  }
  const files = state.files ?? ['verdict.json', 'report.md']
  if (files.length === 0) {
    print(`live:remote: the run folder has no report yet (run exit ${exitCode})`)
    return exitCode
  }
  const outDir = options.out ?? join(outRoot, state.runId)
  try {
    const copied = await copyBack({
      host: options.host,
      runDir: state.runDir,
      runId: state.runId,
      files,
      outDir,
      scp,
      redactor
    })
    print(`live:remote: copied ${copied.files.length} guarded file(s)`)
    print(`REPORT_DIR=${copied.outDir}`)
  } catch (error) {
    printErr(`live:remote: COPY_FAILED (${error.message})`)
    return EXIT_COPY_FAILED
  }
  print(`RUN_EXIT=${exitCode}`)
  return exitCode
}

/** Pure: which of the allowed artifacts a run folder has (for RUN_FILES=). */
export async function presentArtifacts(runDir, { existsFn = exists } = {}) {
  const present = []
  for (const name of RUN_ARTIFACTS) if (await existsFn(join(runDir, name))) present.push(name)
  return present
}

/**
 * The lab half. Every outside effect is injected:
 *   runNode(script, args, { onStdout, onStderr, detached }) -> { code, signal }
 *   loadPolicy() -> { policy, problems }, stopFileExists() -> boolean,
 *   acquireLock(runId) -> { ok, reason }, releaseLock(runId),
 *   presentArtifacts(runDir) -> names
 * Resolves the run's exit code (2 for a refusal before any run).
 */
export async function runLabSide({
  options,
  scripts,
  runNode,
  loadPolicy,
  stopFileExists,
  acquireLock,
  releaseLock,
  presentArtifacts: present = presentArtifacts,
  print = (line) => console.log(line),
  printErr = (line) => console.error(line)
}) {
  const refuse = (reason) => {
    print(`REFUSED (${reason})`)
    print('RUN_EXIT=2')
    return 2
  }
  const forward = { onStdout: (line) => print(line), onStderr: (line) => printErr(line) }
  const candidate = options.build?.kind === 'candidate'
  let installed = false

  if (candidate) {
    if (await stopFileExists()) return refuse('STOP file present')
    const { policy, problems } = await loadPolicy()
    if (!policy) return refuse(`policy missing or invalid: ${(problems ?? []).join('; ')}`)
    if (policy.enabled !== true) return refuse('policy disabled (enabled is false)')
    if (!policy.onDemand?.allowedBuilds?.includes('candidate')) {
      return refuse('build candidate not allowed by the policy')
    }
    const lockId = `on-demand-install-${options.build.id}`
    const lock = await acquireLock(lockId)
    if (!lock.ok) return refuse(lock.reason)
    let install
    try {
      print(`live:remote: installing ${options.build.text}`)
      install = await runNode(scripts.install, ['--build', options.build.text, '--json'], forward)
    } finally {
      await releaseLock(lockId)
    }
    if (install.code === 2) return refuse(`install refused ${options.build.text}`)
    if (install.code !== 0) {
      print(`live:remote: install of ${options.build.text} failed (exit ${install.code})`)
      print('RUN_EXIT=1')
      return 1
    }
    installed = true
  }

  const args = ['--scenario', options.scenario, '--trigger', 'on-demand']
  if (options.build) args.push('--build', options.build.kind)
  if (options.privacy) args.push('--privacy', options.privacy)
  const runState = { runDir: null, runId: null }
  const run = await runNode(scripts.run, args, {
    detached: true,
    onStdout(line) {
      readControlLine(line, runState)
      print(line)
    },
    onStderr: (line) => printErr(line)
  })
  const exitCode = Number.isInteger(run.code) ? run.code : 1

  if (installed) {
    // Scheduled soaks test the public release: put the previous app back.
    const lockId = `on-demand-restore-${options.build.id}`
    const lock = await acquireLock(lockId)
    if (lock.ok) {
      try {
        const restore = await runNode(scripts.install, ['--rollback'], forward)
        print(
          restore.code === 0
            ? 'live:remote: restored the previous app'
            : `live:remote: RESTORE_FAILED (exit ${restore.code}); the candidate is still installed`
        )
      } finally {
        await releaseLock(lockId)
      }
    } else {
      print(`live:remote: RESTORE_SKIPPED (${lock.reason}); the candidate is still installed`)
    }
  }

  if (options.publish && runState.runDir) {
    const published = await runNode(scripts.publish, ['--run', runState.runDir], forward)
    print(`PUBLISH_EXIT=${published.code}`)
  }

  if (runState.runDir) print(`RUN_FILES=${(await present(runState.runDir)).join(',')}`)
  print(`RUN_EXIT=${exitCode}`)
  if (runState.runDir) print(`RUN_DIR=${runState.runDir}`)
  return exitCode
}
