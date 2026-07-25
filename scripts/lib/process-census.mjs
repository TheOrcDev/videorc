import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const RESOURCE_METRICS = ['physicalFootprintBytes', 'openFileCount']

export function ownedProcessLedgerPaths({
  appDataDir,
  userDataDir,
  workspaceRoot,
  appName = 'Videorc'
}) {
  const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)
  return [
    join(appDataDir, appName, 'owned-processes', 'global.json'),
    join(userDataDir, 'owned-processes', `${workspaceKey}.json`)
  ]
}

export function readOwnedProcessLedgers(ledgerPaths, { readFile = readFileSync } = {}) {
  const seen = new Set()
  const records = []
  for (const ledgerPath of ledgerPaths) {
    let parsed
    try {
      parsed = JSON.parse(readFile(ledgerPath, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) {
      continue
    }
    for (const record of parsed) {
      if (!isOwnedProcessRecord(record) || seen.has(record.pid)) {
        continue
      }
      seen.add(record.pid)
      records.push({ ...record, ledgerPath })
    }
  }
  return records
}

export async function collectProcessCensus({
  ledgerPaths,
  pgid,
  rootPid,
  extraPids = [],
  readFile = readFileSync,
  readProcessTable = readSystemProcessTable
}) {
  const records = readOwnedProcessLedgers(ledgerPaths, { readFile })
  const processTable = await readProcessTable()
  const rowsByPid = new Map(processTable.map((row) => [row.pid, row]))
  const interestingPids = new Set([...records.map((record) => record.pid), ...extraPids])
  const processGroupRows =
    typeof pgid === 'number'
      ? processTable.filter((row) => row.pgid === pgid)
      : Number.isInteger(rootPid) && rootPid > 1
        ? processTreeRows(processTable, rootPid)
        : []
  for (const row of processGroupRows) {
    interestingPids.add(row.pid)
  }
  const processRows = processTable
    .filter((row) => interestingPids.has(row.pid))
    .map((row) => ({ ...row, role: classifyProcess(row) }))
    .sort((a, b) => a.pid - b.pid)
  const aliveRecords = records.filter((record) => rowsByPid.has(record.pid))
  const deadRecords = records.filter((record) => !rowsByPid.has(record.pid))

  return {
    records,
    aliveRecords,
    deadRecords,
    processRows,
    processGroupRows: processGroupRows.map((row) => ({ ...row, role: classifyProcess(row) })),
    summary: summarizeRows(processRows)
  }
}

/**
 * Windows does not expose POSIX process groups. Follow the launcher PID and
 * every descendant instead, so an Electron main process, its renderer/GPU
 * children, backend, and FFmpeg are measured as one owned app tree.
 */
export function processTreeRows(processTable, rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) {
    return []
  }
  const childrenByParent = new Map()
  for (const row of processTable ?? []) {
    if (!Number.isInteger(row?.pid) || !Number.isInteger(row?.ppid)) {
      continue
    }
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const rowsByPid = new Map((processTable ?? []).map((row) => [row.pid, row]))
  if (!rowsByPid.has(rootPid)) {
    return []
  }
  const seen = new Set([rootPid])
  const queue = [rootPid]
  while (queue.length > 0) {
    const parentPid = queue.shift()
    for (const child of childrenByParent.get(parentPid) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      queue.push(child.pid)
    }
  }
  return [...seen]
    .map((pid) => rowsByPid.get(pid))
    .filter(Boolean)
    .sort((left, right) => left.pid - right.pid)
}

/**
 * Expensive checkpoint-only details. Keep these out of the one-second census:
 * macOS `footprint` and `lsof` are useful leak evidence, but sampling them at
 * telemetry cadence would perturb the workload under test.
 */
export async function collectProcessResourceDetails(
  census,
  { platform = process.platform, exec = execFileAsync } = {}
) {
  const rows = await Promise.all(
    (census?.processRows ?? []).map(async (row) => {
      const base = {
        pid: row.pid,
        role: row.role,
        physicalFootprintBytes: null,
        openFileCount: null
      }
      if (platform !== 'darwin') return base
      const [physicalFootprintBytes, openFileCount] = await Promise.all([
        macPhysicalFootprintBytes(row.pid, exec),
        macOpenFileCount(row.pid, exec)
      ])
      return { ...base, physicalFootprintBytes, openFileCount }
    })
  )
  const coverage = Object.fromEntries(
    RESOURCE_METRICS.map((metric) => [metric, summarizeResourceMetricCoverage(rows, metric)])
  )
  return {
    capturedAt: new Date().toISOString(),
    rows,
    coverage,
    totals: {
      physicalFootprintBytes: completeResourceMetricTotal(
        rows,
        'physicalFootprintBytes',
        coverage.physicalFootprintBytes
      ),
      openFileCount: completeResourceMetricTotal(rows, 'openFileCount', coverage.openFileCount)
    }
  }
}

/**
 * Capture checkpoint-only resources from a stable process population. The
 * backend's cached diagnostics sampler intentionally launches one exact `ps`
 * observer once per second; exclude only that known backend child and record
 * every exclusion in the checkpoint. Requiring two consecutive identical
 * PID/role censuses plus complete resource coverage handles all other observer
 * races without hiding a persistent process addition, replacement, or failed
 * probe.
 */
export async function collectStableProcessResourceCheckpoint({
  collectCensus,
  collectResources = collectProcessResourceDetails,
  maxAttempts = 8,
  settleMs = 50,
  sleepFn = sleep
}) {
  if (typeof collectCensus !== 'function' || typeof collectResources !== 'function') {
    throw new Error('Stable resource checkpoint requires census and resource collectors.')
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 2) {
    throw new Error(`Stable resource checkpoint requires at least 2 attempts, got ${maxAttempts}.`)
  }

  let previousIdentity = null
  let lastReason = 'no census collected'
  const observedExcludedObservers = new Map()
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const observedCensus = await collectCensus()
    const { census, excludedObservers } = resourceCheckpointCensus(observedCensus)
    for (const observer of excludedObservers) {
      observedExcludedObservers.set(observer.pid, observer)
    }
    const identity = processCensusIdentity(census)
    if (identity === previousIdentity) {
      const checkpoint = await collectResources(census)
      if (resourceCheckpointCoverageComplete(checkpoint)) {
        return {
          census,
          checkpoint: {
            ...checkpoint,
            stability: {
              attempts: attempt,
              consecutiveIdentitySamples: 2,
              excludedObservers: [...observedExcludedObservers.values()].sort(
                (left, right) => left.pid - right.pid
              )
            }
          }
        }
      }
      lastReason = `resource coverage was incomplete (${resourceCheckpointCoverageReason(checkpoint)})`
    } else {
      lastReason = `process population was still changing (${identity})`
    }
    previousIdentity = identity
    if (attempt < maxAttempts && settleMs > 0) await sleepFn(settleMs)
  }

  throw new Error(
    `Could not capture a stable complete process-resource checkpoint after ${maxAttempts} attempts: ${lastReason}`
  )
}

/**
 * Resource totals are only meaningful deltas when both checkpoints covered the
 * same live processes. Keep exact PID continuity separate from role-population
 * continuity so a helper restart cannot masquerade as a memory/file decrease.
 */
export function compareProcessResourceCheckpoints(first, last) {
  const firstRowsByPid = resourceRowsByPid(first?.rows)
  const lastRowsByPid = resourceRowsByPid(last?.rows)
  const firstPids = [...firstRowsByPid.keys()].sort((a, b) => a - b)
  const lastPids = [...lastRowsByPid.keys()].sort((a, b) => a - b)
  const retainedPids = firstPids.filter((pid) => lastRowsByPid.has(pid))
  const removedPids = firstPids.filter((pid) => !lastRowsByPid.has(pid))
  const addedPids = lastPids.filter((pid) => !firstRowsByPid.has(pid))
  const roleChanges = retainedPids
    .filter((pid) => firstRowsByPid.get(pid).role !== lastRowsByPid.get(pid).role)
    .map((pid) => ({
      pid,
      firstRole: firstRowsByPid.get(pid).role,
      lastRole: lastRowsByPid.get(pid).role
    }))
  const roles = [
    ...new Set([
      ...[...firstRowsByPid.values()].map((row) => row.role),
      ...[...lastRowsByPid.values()].map((row) => row.role)
    ])
  ].sort()
  const byRole = Object.fromEntries(
    roles.map((role) => {
      const roleFirstPids = pidsForRole(firstRowsByPid, role)
      const roleLastPids = pidsForRole(lastRowsByPid, role)
      const roleRetainedPids = roleFirstPids.filter((pid) => roleLastPids.includes(pid))
      const roleRemovedPids = roleFirstPids.filter((pid) => !roleLastPids.includes(pid))
      const roleAddedPids = roleLastPids.filter((pid) => !roleFirstPids.includes(pid))
      return [
        role,
        {
          firstPids: roleFirstPids,
          lastPids: roleLastPids,
          retainedPids: roleRetainedPids,
          removedPids: roleRemovedPids,
          addedPids: roleAddedPids,
          pidContinuity: roleRemovedPids.length === 0 && roleAddedPids.length === 0,
          countContinuity: roleFirstPids.length === roleLastPids.length
        }
      ]
    })
  )
  const replacements = Object.entries(byRole)
    .filter(([, role]) => role.removedPids.length > 0 && role.addedPids.length > 0)
    .map(([role, details]) => ({
      role,
      removedPids: details.removedPids,
      addedPids: details.addedPids
    }))
  const pidContinuity = removedPids.length === 0 && addedPids.length === 0
  const roleContinuity =
    roleChanges.length === 0 && Object.values(byRole).every((role) => role.countContinuity)
  const processContinuity = {
    comparable: pidContinuity && roleContinuity,
    pidContinuity,
    roleContinuity,
    firstCount: firstPids.length,
    lastCount: lastPids.length,
    retainedPids,
    removedPids,
    addedPids,
    roleChanges,
    replacements,
    byRole
  }

  return {
    processContinuity,
    metrics: Object.fromEntries(
      RESOURCE_METRICS.map((metric) => [
        metric,
        compareResourceMetric(metric, first, last, processContinuity)
      ])
    )
  }
}

export async function waitForCleanProcessState({
  ledgerPaths,
  pgid,
  rootPid,
  timeoutMs = 10000,
  intervalMs = 250,
  readFile = readFileSync,
  readProcessTable = readSystemProcessTable
}) {
  const deadline = Date.now() + timeoutMs
  let lastCensus = null
  while (Date.now() <= deadline) {
    lastCensus = await collectProcessCensus({
      ledgerPaths,
      pgid,
      rootPid,
      readFile,
      readProcessTable
    })
    if (lastCensus.records.length === 0 && lastCensus.processGroupRows.length === 0) {
      return lastCensus
    }
    await sleep(intervalMs)
  }

  const details = lastCensus ? formatCensus(lastCensus) : 'No process census was collected.'
  throw new Error(`Timed out waiting for clean process state.\n${details}`)
}

export async function waitForNoLiveProcessState({
  ledgerPaths,
  pgid,
  rootPid,
  timeoutMs = 10000,
  intervalMs = 250,
  readFile = readFileSync,
  readProcessTable = readSystemProcessTable
}) {
  const deadline = Date.now() + timeoutMs
  let lastCensus = null
  while (Date.now() <= deadline) {
    lastCensus = await collectProcessCensus({
      ledgerPaths,
      pgid,
      rootPid,
      readFile,
      readProcessTable
    })
    if (lastCensus.aliveRecords.length === 0 && lastCensus.processGroupRows.length === 0) {
      return lastCensus
    }
    await sleep(intervalMs)
  }

  const details = lastCensus ? formatCensus(lastCensus) : 'No process census was collected.'
  throw new Error(`Timed out waiting for live owned processes to exit.\n${details}`)
}

/**
 * Assert teardown truth before performing best-effort recovery. Recovery may
 * make a dirty host usable again, but it must never turn the original failure
 * into a passing lifecycle smoke. A recovery rejection is exposed as the
 * original error's `recoveryError` diagnostic without replacing that error.
 */
export async function verifyCleanProcessStateBeforeRecovery({ verify, recover }) {
  try {
    return await verify()
  } catch (error) {
    try {
      await recover()
    } catch (recoveryError) {
      if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
        try {
          Reflect.defineProperty(error, 'recoveryError', {
            configurable: true,
            enumerable: true,
            value: recoveryError
          })
        } catch {
          // Diagnostic attachment must never replace the original verification failure.
        }
      }
    }
    throw error
  }
}

export async function pruneDeadOwnedProcessRecords({
  ledgerPaths,
  readFile = readFileSync,
  writeFile = writeFileSync,
  readProcessTable = readSystemProcessTable
}) {
  const processTable = await readProcessTable()
  const alivePids = new Set(processTable.map((row) => row.pid))
  const pruned = []
  for (const ledgerPath of ledgerPaths) {
    let parsed
    try {
      parsed = JSON.parse(readFile(ledgerPath, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) {
      continue
    }
    const kept = []
    const removed = []
    for (const record of parsed) {
      if (!isOwnedProcessRecord(record) || !alivePids.has(record.pid)) {
        removed.push(record)
        continue
      }
      kept.push(record)
    }
    if (removed.length > 0) {
      writeFile(ledgerPath, `${JSON.stringify(kept, null, 2)}\n`)
      pruned.push({ ledgerPath, removed, kept })
    }
  }
  return pruned
}

export async function readSystemProcessTable({ platform = process.platform } = {}) {
  if (platform === 'win32') {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        [
          'Get-CimInstance Win32_Process',
          'Select-Object ProcessId,ParentProcessId,CreationDate,WorkingSetSize,KernelModeTime,UserModeTime,ExecutablePath,CommandLine',
          'ConvertTo-Json -Compress'
        ].join(' | ')
      ],
      { maxBuffer: 16 * 1024 * 1024 }
    )
    return parseWindowsProcessTable(stdout)
  }

  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,comm=,args='])
  return parseProcessTable(stdout)
}

export function parseProcessTable(stdout) {
  const rows = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line)
    if (!match) {
      continue
    }
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssKb: Number(match[4]),
      command: match[5],
      args: match[6] ?? ''
    })
  }
  return rows
}

export function parseWindowsProcessTable(stdout) {
  const trimmed = typeof stdout === 'string' ? stdout.trim() : ''
  if (!trimmed) {
    return []
  }

  const parsed = JSON.parse(trimmed)
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries
    .map((entry) => windowsProcessRow(entry))
    .filter((row) => row !== null)
    .sort((a, b) => a.pid - b.pid)
}

export function classifyProcess(row) {
  const text = `${row.command} ${row.args}`
  const lowerText = text.toLowerCase()
  const commandName = (row.command.split(/[\\/]/).pop() ?? row.command).toLowerCase()
  const argumentExecutableName = processArgumentExecutableName(row.args)
  const executableNames = new Set([commandName, argumentExecutableName])
  if (commandName === 'cargo') {
    return 'cargo'
  }
  if (
    executableNames.has('native_preview_host_helper') ||
    executableNames.has('native_preview_host_helper.exe')
  ) {
    return 'native-preview-helper'
  }
  if (executableNames.has('videorc-backend') || executableNames.has('videorc-backend.exe')) {
    return 'backend'
  }
  if (lowerText.includes('ffmpeg')) {
    return 'ffmpeg'
  }
  if (lowerText.includes('ffprobe')) {
    return 'ffprobe'
  }
  for (const role of ['notes', 'comments', 'captions']) {
    if (lowerText.includes(`--videorc-renderer-role=${role}`)) {
      return `electron-renderer-${role}`
    }
  }
  if (lowerText.includes('--type=renderer')) {
    return 'electron-renderer'
  }
  if (lowerText.includes('--type=gpu-process')) {
    return 'electron-gpu'
  }
  if (lowerText.includes('--type=')) {
    return 'electron-child'
  }
  if (
    (executableNames.has('electron') &&
      /electron\.app\/contents\/macos\/electron/.test(lowerText)) ||
    executableNames.has('electron.exe') ||
    executableNames.has('videorc') ||
    executableNames.has('videorc.exe')
  ) {
    return 'electron-main'
  }
  if (
    lowerText.includes('pnpm') ||
    lowerText.includes('electron-vite') ||
    lowerText.includes('esbuild')
  ) {
    return 'tooling'
  }
  return 'other'
}

function processArgumentExecutableName(args) {
  const match = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(args ?? '')
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? ''
  return (executable.split(/[\\/]/).pop() ?? executable).toLowerCase()
}

export function summarizeRows(rows) {
  const summary = {}
  for (const row of rows) {
    const role = row.role ?? classifyProcess(row)
    const entry = (summary[role] ??= { count: 0, rssKb: 0 })
    entry.count += 1
    entry.rssKb += row.rssKb
  }
  return summary
}

export function formatCensus(census) {
  const lines = []
  lines.push(`ledger records: ${census.records.length}`)
  for (const record of census.records) {
    const state = census.aliveRecords.some((alive) => alive.pid === record.pid) ? 'alive' : 'dead'
    lines.push(`  ${state} ${record.label}:${record.pid} from ${record.ledgerPath}`)
  }
  lines.push(`process group rows: ${census.processGroupRows.length}`)
  for (const row of census.processRows) {
    lines.push(
      `  pid=${row.pid} ppid=${row.ppid} pgid=${row.pgid} role=${row.role} rss=${row.rssKb}KB args=${row.args}`
    )
  }
  return lines.join('\n')
}

export function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function ledgerExists(ledgerPath) {
  return existsSync(ledgerPath)
}

function isOwnedProcessRecord(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isInteger(value.pid) &&
    value.pid > 1 &&
    typeof value.label === 'string' &&
    typeof value.startedAt === 'string'
  )
}

function summarizeResourceMetricCoverage(rows, metric) {
  const roles = [...new Set(rows.map((row) => row.role))].sort()
  const byRole = Object.fromEntries(
    roles.map((role) => {
      const roleRows = rows.filter((row) => row.role === role)
      const succeeded = roleRows.filter((row) => Number.isFinite(row[metric])).length
      return [
        role,
        {
          requested: roleRows.length,
          succeeded,
          complete: roleRows.length > 0 && succeeded === roleRows.length
        }
      ]
    })
  )
  const succeeded = rows.filter((row) => Number.isFinite(row[metric])).length
  return {
    requested: rows.length,
    succeeded,
    complete: rows.length > 0 && succeeded === rows.length,
    byRole
  }
}

function processCensusIdentity(census) {
  return (census?.processRows ?? [])
    .map((row) => `${row.pid}:${row.role ?? 'other'}`)
    .sort()
    .join(',')
}

function resourceCheckpointCensus(census) {
  const processRows = census?.processRows ?? []
  const backendPids = new Set(
    processRows.filter((row) => row.role === 'backend').map((row) => row.pid)
  )
  const excludedRows = processRows.filter((row) =>
    isBackendRuntimeResourceSampler(row, backendPids)
  )
  if (excludedRows.length === 0) {
    return { census, excludedObservers: [] }
  }
  const excludedPids = new Set(excludedRows.map((row) => row.pid))
  const retainedRows = processRows.filter((row) => !excludedPids.has(row.pid))
  return {
    census: {
      ...census,
      processRows: retainedRows,
      summary: summarizeRows(retainedRows)
    },
    excludedObservers: excludedRows.map((row) => ({
      pid: row.pid,
      role: row.role,
      command: row.command,
      args: row.args
    }))
  }
}

function isBackendRuntimeResourceSampler(row, backendPids) {
  if (
    row?.role !== 'other' ||
    !backendPids.has(row.ppid) ||
    basename(String(row.command ?? '')) !== 'ps'
  ) {
    return false
  }
  const args = String(row.args ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  return /^(?:(?:\/usr)?\/bin\/)?ps -axo pid=,ppid=,rss=,comm=$/.test(args)
}

function resourceCheckpointCoverageComplete(checkpoint) {
  return RESOURCE_METRICS.every((metric) => checkpoint?.coverage?.[metric]?.complete === true)
}

function resourceCheckpointCoverageReason(checkpoint) {
  return RESOURCE_METRICS.map(
    (metric) => `${metric}=${coverageRatio(checkpoint?.coverage?.[metric])}`
  ).join(', ')
}

function completeResourceMetricTotal(rows, metric, coverage) {
  if (!coverage.complete) return null
  return rows.reduce((total, row) => total + row[metric], 0)
}

function resourceRowsByPid(rows) {
  return new Map(
    (rows ?? [])
      .filter((row) => Number.isInteger(row?.pid) && row.pid > 0)
      .map((row) => [row.pid, { ...row, role: row.role ?? 'other' }])
  )
}

function pidsForRole(rowsByPid, role) {
  return [...rowsByPid.values()]
    .filter((row) => row.role === role)
    .map((row) => row.pid)
    .sort((a, b) => a - b)
}

function compareResourceMetric(metric, first, last, processContinuity) {
  const reasons = []
  const firstCoverage = first?.coverage?.[metric]
  const lastCoverage = last?.coverage?.[metric]
  if (firstCoverage?.complete !== true) {
    reasons.push(`first coverage incomplete (${coverageRatio(firstCoverage)})`)
  }
  if (lastCoverage?.complete !== true) {
    reasons.push(`last coverage incomplete (${coverageRatio(lastCoverage)})`)
  }
  if (!processContinuity.pidContinuity) {
    const replacements = processContinuity.replacements
      .map(
        (replacement) =>
          `${replacement.role} ${replacement.removedPids.join(',')} -> ${replacement.addedPids.join(',')}`
      )
      .join('; ')
    reasons.push(`process PID set changed${replacements ? ` (${replacements})` : ''}`)
  }
  if (!processContinuity.roleContinuity) {
    reasons.push('process role population changed')
  }
  const firstTotal = first?.totals?.[metric]
  const lastTotal = last?.totals?.[metric]
  if (!Number.isFinite(firstTotal) && firstCoverage?.complete === true) {
    reasons.push('first total missing')
  }
  if (!Number.isFinite(lastTotal) && lastCoverage?.complete === true) {
    reasons.push('last total missing')
  }
  const comparable = reasons.length === 0
  return {
    comparable,
    first: Number.isFinite(firstTotal) ? firstTotal : null,
    last: Number.isFinite(lastTotal) ? lastTotal : null,
    delta: comparable ? lastTotal - firstTotal : null,
    reasons
  }
}

function coverageRatio(coverage) {
  return `${coverage?.succeeded ?? 0}/${coverage?.requested ?? 0}`
}

async function macPhysicalFootprintBytes(pid, exec) {
  try {
    const { stdout } = await exec('footprint', ['-p', String(pid), '-f', 'bytes', '--noCategories'])
    const match = /phys_footprint:\s+(\d+)\s+B/i.exec(stdout)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function macOpenFileCount(pid, exec) {
  try {
    const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-Ff'])
    return stdout.split('\n').filter((line) => /^f\d+$/.test(line)).length
  } catch {
    return null
  }
}

function windowsProcessRow(entry) {
  const pid = Number(entry?.ProcessId)
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  const ppid = Number(entry?.ParentProcessId)
  const workingSetSize = Number(entry?.WorkingSetSize)
  const kernelModeTime = Number(entry?.KernelModeTime)
  const userModeTime = Number(entry?.UserModeTime)
  const creationDate =
    typeof entry?.CreationDate === 'string' && entry.CreationDate.trim() ? entry.CreationDate : null
  const args = typeof entry?.CommandLine === 'string' ? entry.CommandLine : ''
  const command =
    typeof entry?.ExecutablePath === 'string' && entry.ExecutablePath.trim()
      ? entry.ExecutablePath
      : firstWindowsCommandToken(args)

  return {
    pid,
    ppid: Number.isInteger(ppid) && ppid >= 0 ? ppid : 0,
    pgid: null,
    rssKb: Number.isFinite(workingSetSize) ? Math.round(workingSetSize / 1024) : 0,
    cpuTimeMs:
      Number.isFinite(kernelModeTime) && Number.isFinite(userModeTime)
        ? (kernelModeTime + userModeTime) / 10_000
        : null,
    creationDate,
    command,
    args
  }
}

function firstWindowsCommandToken(commandLine) {
  if (typeof commandLine !== 'string') {
    return ''
  }
  const trimmed = commandLine.trim()
  if (!trimmed) {
    return ''
  }
  const quoted = /^"([^"]+)"/.exec(trimmed)
  if (quoted) {
    return quoted[1]
  }
  return trimmed.split(/\s+/)[0] ?? ''
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
