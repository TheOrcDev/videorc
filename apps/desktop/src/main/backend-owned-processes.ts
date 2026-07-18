import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export interface OwnedProcessIdentity {
  birthToken: string
  executablePath: string
}

export interface OwnedProcessRecord {
  pid: number
  label: string
  startedAt: string
  /** Missing only on legacy ledgers written before identity-safe reaping. */
  identity?: OwnedProcessIdentity
}

export type OwnedProcessProbeResult =
  | { state: 'dead' }
  | { state: 'live'; identity: OwnedProcessIdentity }
  | { state: 'unprobeable' }

export type RecordedProcessOwnership = 'owned' | 'gone' | 'unconfirmed'

type KillProcess = (pid: number, signal: NodeJS.Signals) => void
type Sleep = (delayMs: number) => void
type ProbeProcess = (pid: number) => OwnedProcessProbeResult
type OpenExclusiveFile = (path: string) => number
type CloseFile = (fileDescriptor: number) => void
type RemoveFile = (path: string) => void

export interface OwnedProcessRegistryOptions {
  ledgerPath: string | string[]
  currentPid?: number
  platform?: NodeJS.Platform
  now?: () => string
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  killProcess?: KillProcess
  sleep?: Sleep
  probeProcess?: ProbeProcess
}

export interface ReapOwnedProcessesOptions {
  disabled?: boolean
  killGraceMs?: number
  confirmTimeoutMs?: number
  retryMs?: number
}

export interface ReapOwnedProcessesResult {
  skipped: boolean
  attempted: OwnedProcessRecord[]
  confirmedDead: OwnedProcessRecord[]
  identityMismatches: OwnedProcessRecord[]
  unconfirmed: OwnedProcessRecord[]
}

export interface OwnedProcessStartupLockOptions {
  lockPath: string
  timeoutMs?: number
  retryMs?: number
  currentPid?: number
  nowMs?: () => number
  sleep?: Sleep
  makeDir?: (path: string) => void
  openFileExclusive?: OpenExclusiveFile
  closeFile?: CloseFile
  removeFile?: RemoveFile
  writeFile?: (path: string, contents: string) => void
}

export function ownedProcessLedgerPath(userDataPath: string, workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)
  return join(userDataPath, 'owned-processes', `${key}.json`)
}

export function globalOwnedProcessLedgerPath(appDataPath: string, appName: string): string {
  return join(appDataPath, appName, 'owned-processes', 'global.json')
}

export function ownedProcessStartupLockPath(appDataPath: string, appName: string): string {
  return join(appDataPath, appName, 'owned-processes', 'startup.lock')
}

export function acquireOwnedProcessStartupLock(
  options: OwnedProcessStartupLockOptions
): () => void {
  const timeoutMs = options.timeoutMs ?? 5000
  const retryMs = options.retryMs ?? 50
  const currentPid = options.currentPid ?? process.pid
  const nowMs = options.nowMs ?? (() => Date.now())
  const sleep = options.sleep ?? sleepSync
  const makeDir = options.makeDir ?? ((path) => mkdirSync(path, { recursive: true }))
  const openFileExclusive = options.openFileExclusive ?? ((path) => openSync(path, 'wx', 0o600))
  const closeFile = options.closeFile ?? ((fileDescriptor) => closeSync(fileDescriptor))
  const removeFile = options.removeFile ?? ((path) => unlinkSync(path))
  const writeFile = options.writeFile ?? ((path, contents) => writeFileSync(path, contents))
  const startedAtMs = nowMs()

  makeDir(dirname(options.lockPath))

  for (;;) {
    let fileDescriptor: number | null = null
    try {
      fileDescriptor = openFileExclusive(options.lockPath)
      writeFile(
        options.lockPath,
        `${JSON.stringify({ pid: currentPid, acquiredAt: new Date().toISOString() }, null, 2)}\n`
      )
      const ownedFileDescriptor = fileDescriptor
      let released = false
      return () => {
        if (released) {
          return
        }
        released = true
        try {
          closeFile(ownedFileDescriptor)
        } catch {
          // The descriptor may already be closed; releasing the lock should be best-effort.
        }
        try {
          removeFile(options.lockPath)
        } catch {
          // A later process may already have cleaned up a stale lock.
        }
      }
    } catch (error) {
      if (fileDescriptor !== null) {
        try {
          closeFile(fileDescriptor)
        } catch {
          // Best effort.
        }
      }

      const code =
        typeof error === 'object' && error ? (error as { code?: string }).code : undefined
      if (code !== 'EEXIST') {
        throw error
      }
      if (nowMs() - startedAtMs >= timeoutMs) {
        throw new Error(`Timed out waiting for owned process startup lock at ${options.lockPath}`, {
          cause: error
        })
      }
      sleep(retryMs)
    }
  }
}

export class OwnedProcessRegistry {
  private readonly ledgerPaths: string[]
  private readonly currentPid: number
  private readonly platform: NodeJS.Platform
  private readonly now: () => string
  private readonly readFile: (path: string) => string
  private readonly writeFile: (path: string, contents: string) => void
  private readonly makeDir: (path: string) => void
  private readonly killProcess: KillProcess
  private readonly sleep: Sleep
  private readonly probeProcess: ProbeProcess

  constructor(private readonly options: OwnedProcessRegistryOptions) {
    const ledgerPaths = Array.isArray(options.ledgerPath)
      ? options.ledgerPath
      : [options.ledgerPath]
    this.ledgerPaths = Array.from(new Set(ledgerPaths))
    this.currentPid = options.currentPid ?? process.pid
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date().toISOString())
    this.readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
    this.writeFile = options.writeFile ?? ((path, contents) => writeFileSync(path, contents))
    this.makeDir = options.makeDir ?? ((path) => mkdirSync(path, { recursive: true }))
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.sleep = options.sleep ?? sleepSync
    this.probeProcess =
      options.probeProcess ?? ((pid) => probeExactOwnedProcess(pid, this.platform))
  }

  record(pid: number | undefined, label: string): void {
    if (!validPid(pid) || pid === this.currentPid) {
      return
    }

    const probe = this.probeForRegistration(pid)
    if (probe.state === 'dead') {
      throw new Error(`Could not record ${label} process ${pid}: the process is already dead.`)
    }
    if (probe.state === 'unprobeable') {
      throw new Error(
        `Could not record ${label} process ${pid}: exact process identity is unavailable.`
      )
    }

    const records = this.readRecords().filter((record) => record.pid !== pid)
    records.push({ pid, label, startedAt: this.now(), identity: probe.identity })
    this.writeRecords(records)
  }

  remove(pid: number | undefined): void {
    if (!validPid(pid)) {
      return
    }

    const records = this.readRecords().filter((record) => record.pid !== pid)
    this.writeRecords(records)
  }

  /**
   * Reconcile an in-memory PID claim against its durable identity without
   * signaling the process. `gone` means the recorded process exited, even if
   * the numeric PID is now occupied by a different process.
   */
  probeRecordedOwnership(pid: number): RecordedProcessOwnership {
    if (!validPid(pid) || pid === this.currentPid) {
      return 'unconfirmed'
    }

    const record = this.readRecords().find((candidate) => candidate.pid === pid)
    const probe = this.safeProbe(pid)
    if (probe.state === 'dead') {
      return 'gone'
    }
    if (probe.state === 'unprobeable' || !record?.identity) {
      return 'unconfirmed'
    }
    return processIdentitiesEqual(record.identity, probe.identity) ? 'owned' : 'gone'
  }

  reapStale(options: ReapOwnedProcessesOptions = {}): ReapOwnedProcessesResult {
    if (options.disabled) {
      return {
        skipped: true,
        attempted: [],
        confirmedDead: [],
        identityMismatches: [],
        unconfirmed: []
      }
    }

    const stale = dedupeRecords(
      this.readRecords().filter((record) => record.pid !== this.currentPid && validPid(record.pid))
    )
    if (stale.length === 0) {
      return {
        skipped: false,
        attempted: [],
        confirmedDead: [],
        identityMismatches: [],
        unconfirmed: []
      }
    }

    const confirmedDeadPids = new Set<number>()
    const identityMismatchPids = new Set<number>()
    const unconfirmedPids = new Set<number>()
    const attemptedPids = new Set<number>()
    const classifyMatching = (records: OwnedProcessRecord[]): OwnedProcessRecord[] =>
      this.matchingLiveRecords(records, confirmedDeadPids, identityMismatchPids, unconfirmedPids)

    let matching = classifyMatching(stale)
    const killGraceMs = options.killGraceMs ?? 1500
    const confirmTimeoutMs = options.confirmTimeoutMs ?? 1500
    const retryMs = Math.max(1, options.retryMs ?? 25)

    if (this.platform === 'win32') {
      // Windows has no graceful signal: Node maps every signal to
      // TerminateProcess, so the SIGTERM → grace → SIGKILL ladder collapses
      // into one hard kill. Only ledger-recorded PIDs are touched, same as
      // the Unix arm.
      matching = classifyMatching(matching)
      for (const record of matching) {
        attemptedPids.add(record.pid)
        this.tryKill(record.pid, 'SIGKILL')
      }
      matching = this.waitForExit(matching, confirmTimeoutMs, retryMs, classifyMatching)
    } else {
      matching = classifyMatching(matching)
      for (const record of matching) {
        attemptedPids.add(record.pid)
        this.tryKill(record.pid, 'SIGTERM')
      }
      matching = this.waitForExit(matching, killGraceMs, retryMs, classifyMatching)
      matching = classifyMatching(matching)
      for (const record of matching) {
        this.tryKill(record.pid, 'SIGKILL')
      }
      matching = this.waitForExit(matching, confirmTimeoutMs, retryMs, classifyMatching)
    }

    for (const record of matching) {
      unconfirmedPids.add(record.pid)
    }
    const attempted = stale.filter((record) => attemptedPids.has(record.pid))
    const confirmedDead = stale.filter((record) => confirmedDeadPids.has(record.pid))
    const identityMismatches = stale.filter((record) => identityMismatchPids.has(record.pid))
    const unconfirmed = stale.filter((record) => unconfirmedPids.has(record.pid))
    // Retain evidence unless the recorded process is confirmed dead or the PID
    // is confirmed to belong to a different identity. Failed/forbidden probes
    // and kills therefore block replacement startup and remain recoverable.
    this.writeRecords(unconfirmed)
    return { skipped: false, attempted, confirmedDead, identityMismatches, unconfirmed }
  }

  private tryKill(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killProcess(pid, signal)
    } catch {
      // The process may have already exited; stale ledgers should not fail app startup.
    }
  }

  private probeForRegistration(pid: number): OwnedProcessProbeResult {
    let result = this.safeProbe(pid)
    for (let attempt = 1; attempt < 3 && result.state === 'unprobeable'; attempt += 1) {
      this.sleep(10)
      result = this.safeProbe(pid)
    }
    return result
  }

  private safeProbe(pid: number): OwnedProcessProbeResult {
    try {
      return this.probeProcess(pid)
    } catch {
      return { state: 'unprobeable' }
    }
  }

  private matchingLiveRecords(
    records: OwnedProcessRecord[],
    confirmedDeadPids: Set<number>,
    identityMismatchPids: Set<number>,
    unconfirmedPids: Set<number>
  ): OwnedProcessRecord[] {
    const matching: OwnedProcessRecord[] = []
    for (const record of records) {
      const probe = this.safeProbe(record.pid)
      if (probe.state === 'dead') {
        confirmedDeadPids.add(record.pid)
        continue
      }
      if (probe.state === 'unprobeable' || !record.identity) {
        unconfirmedPids.add(record.pid)
        continue
      }
      if (!processIdentitiesEqual(record.identity, probe.identity)) {
        identityMismatchPids.add(record.pid)
        continue
      }
      matching.push(record)
    }
    return matching
  }

  private waitForExit(
    records: OwnedProcessRecord[],
    timeoutMs: number,
    retryMs: number,
    classifyMatching: (records: OwnedProcessRecord[]) => OwnedProcessRecord[]
  ): OwnedProcessRecord[] {
    let remaining = classifyMatching(records)
    const attempts = Math.max(1, Math.ceil(Math.max(0, timeoutMs) / retryMs))
    for (let attempt = 0; attempt < attempts && remaining.length > 0; attempt += 1) {
      this.sleep(retryMs)
      remaining = classifyMatching(remaining)
    }
    return remaining
  }

  private readRecords(): OwnedProcessRecord[] {
    return dedupeRecords(
      this.ledgerPaths.flatMap((ledgerPath) => this.readLedgerRecords(ledgerPath))
    )
  }

  private readLedgerRecords(ledgerPath: string): OwnedProcessRecord[] {
    let contents: string
    try {
      contents = this.readFile(ledgerPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return []
      }
      throw new Error(`Could not read owned process ledger at ${ledgerPath}.`, { cause: error })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(contents) as unknown
    } catch (error) {
      throw new Error(`Could not parse owned process ledger at ${ledgerPath}.`, { cause: error })
    }
    if (!Array.isArray(parsed) || !parsed.every(isOwnedProcessRecord)) {
      throw new Error(`Owned process ledger at ${ledgerPath} has an invalid record shape.`)
    }
    return parsed
  }

  private writeRecords(records: OwnedProcessRecord[]): void {
    for (const ledgerPath of this.ledgerPaths) {
      this.makeDir(dirname(ledgerPath))
      this.writeFile(ledgerPath, `${JSON.stringify(records, null, 2)}\n`)
    }
  }
}

function dedupeRecords(records: OwnedProcessRecord[]): OwnedProcessRecord[] {
  const seen = new Set<number>()
  const deduped: OwnedProcessRecord[] = []
  for (const record of records) {
    if (seen.has(record.pid)) {
      continue
    }
    seen.add(record.pid)
    deduped.push(record)
  }
  return deduped
}

function isOwnedProcessRecord(value: unknown): value is OwnedProcessRecord {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<OwnedProcessRecord>
  return (
    validPid(record.pid) &&
    typeof record.label === 'string' &&
    typeof record.startedAt === 'string' &&
    (record.identity === undefined || isOwnedProcessIdentity(record.identity))
  )
}

function isOwnedProcessIdentity(value: unknown): value is OwnedProcessIdentity {
  if (!value || typeof value !== 'object') {
    return false
  }
  const identity = value as Partial<OwnedProcessIdentity>
  return (
    typeof identity.birthToken === 'string' &&
    identity.birthToken.length > 0 &&
    typeof identity.executablePath === 'string' &&
    identity.executablePath.length > 0
  )
}

function processIdentitiesEqual(
  expected: OwnedProcessIdentity,
  actual: OwnedProcessIdentity
): boolean {
  return (
    expected.birthToken === actual.birthToken && expected.executablePath === actual.executablePath
  )
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined
}

function exactProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ESRCH'
    )
  }
}

function probeExactOwnedProcess(pid: number, platform: NodeJS.Platform): OwnedProcessProbeResult {
  if (!exactProcessIsAlive(pid)) {
    return { state: 'dead' }
  }
  if (platform === 'linux') {
    return probeLinuxProcess(pid)
  }
  if (platform === 'darwin') {
    return probeDarwinProcess(pid)
  }
  if (platform === 'win32') {
    return probeWindowsProcess(pid)
  }
  return { state: 'unprobeable' }
}

function probeLinuxProcess(pid: number): OwnedProcessProbeResult {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = linuxProcessBirthToken(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      const executablePath = readlinkSync(`/proc/${pid}/exe`)
      const after = linuxProcessBirthToken(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      if (before && before === after && executablePath) {
        return { state: 'live', identity: { birthToken: before, executablePath } }
      }
    }
  } catch {
    // The exact liveness check below distinguishes exit from an unreadable proc entry.
  }
  return exactProcessIsAlive(pid) ? { state: 'unprobeable' } : { state: 'dead' }
}

function linuxProcessBirthToken(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) {
    return undefined
  }
  // Fields after the command begin at stat field 3 (state); starttime is field
  // 22, therefore index 19 in this suffix.
  return stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)[19]
}

function probeDarwinProcess(pid: number): OwnedProcessProbeResult {
  try {
    const output = execFileSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='],
      exactProbeExecOptions()
    ).trim()
    const match = /^(.{24})\s+(.+)$/.exec(output)
    if (match?.[1] && match[2]) {
      return {
        state: 'live',
        identity: { birthToken: match[1], executablePath: match[2].trim() }
      }
    }
  } catch {
    // The exact liveness check below distinguishes exit from an unreadable ps row.
  }
  return exactProcessIsAlive(pid) ? { state: 'unprobeable' } : { state: 'dead' }
}

function probeWindowsProcess(pid: number): OwnedProcessProbeResult {
  const systemRoot = process.env.SystemRoot?.trim()
  const powershell = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const script = [
    `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
    '$identity = [PSCustomObject]@{ birthToken = $target.StartTime.ToUniversalTime().Ticks.ToString(); executablePath = $target.Path }',
    '$identity | ConvertTo-Json -Compress'
  ].join('; ')
  try {
    const parsed = JSON.parse(
      execFileSync(
        powershell,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
        exactProbeExecOptions()
      ).trim()
    ) as unknown
    if (isOwnedProcessIdentity(parsed)) {
      return { state: 'live', identity: parsed }
    }
  } catch {
    // The exact liveness check below distinguishes exit from an unreadable process handle.
  }
  return exactProcessIsAlive(pid) ? { state: 'unprobeable' } : { state: 'dead' }
}

function exactProbeExecOptions(): {
  encoding: 'utf8'
  timeout: number
  maxBuffer: number
  windowsHide: true
} {
  return { encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024, windowsHide: true }
}

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}
