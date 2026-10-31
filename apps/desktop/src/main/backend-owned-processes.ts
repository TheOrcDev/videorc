import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  statSync,
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
export type RecordedProcessSignalResult = 'signalled' | 'gone' | 'unconfirmed'

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
  /** A lock whose contents never arrived is reclaimed once it is this old. */
  staleAfterMs?: number
  currentPid?: number
  nowMs?: () => number
  sleep?: Sleep
  makeDir?: (path: string) => void
  openFileExclusive?: OpenExclusiveFile
  closeFile?: CloseFile
  removeFile?: RemoveFile
  writeFile?: (path: string, contents: string) => void
  readFile?: (path: string) => string
  /** Age of the lock file in ms, or null when it cannot be read. */
  fileAgeMs?: (path: string) => number | null
  processAlive?: (pid: number) => boolean
}

/**
 * Pure: whether an existing startup lock belongs to nobody. A lock names the
 * pid that took it; when that pid is gone (or is this very process, which
 * cannot be holding a lock it is trying to take), the holder crashed while it
 * held the lock and nothing else will ever remove it. A lock with no readable
 * pid is a writer that crashed between open and write, or one still writing,
 * so it is stale only once it is older than `staleAfterMs`.
 */
export function startupLockIsStale(
  contents: string | null,
  ageMs: number | null,
  options: { currentPid: number; staleAfterMs: number; processAlive: (pid: number) => boolean }
): boolean {
  let pid: unknown
  try {
    pid = contents ? (JSON.parse(contents) as { pid?: unknown }).pid : undefined
  } catch {
    pid = undefined
  }
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    return pid === options.currentPid || !options.processAlive(pid)
  }
  return ageMs !== null && ageMs >= options.staleAfterMs
}

function processAliveSync(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM'
  }
}

function lockFileAgeMs(path: string): number | null {
  try {
    return Math.max(0, Date.now() - statSync(path).mtimeMs)
  } catch {
    return null
  }
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
  const staleAfterMs = options.staleAfterMs ?? 60_000
  const currentPid = options.currentPid ?? process.pid
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
  const fileAgeMs = options.fileAgeMs ?? lockFileAgeMs
  const processAlive = options.processAlive ?? processAliveSync
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
      // The token makes this lock instance distinguishable from a replacement
      // at the same path, so neither a reclaimer nor this release can remove
      // a lock it did not observe.
      const ownedContents = `${JSON.stringify(
        { pid: currentPid, acquiredAt: new Date().toISOString(), token: randomUUID() },
        null,
        2
      )}\n`
      writeFile(options.lockPath, ownedContents)
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
        let current: string
        try {
          current = readFile(options.lockPath)
        } catch {
          // Gone already, or unreadable: without our token there is no proof
          // the path still holds our lock. One left behind names this pid,
          // so the next launch reclaims it once this process is gone.
          return
        }
        if (current !== ownedContents) {
          // Not ours any more: another process holds this path now.
          return
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

      if (errorCode(error) !== 'EEXIST') {
        throw error
      }
      // A holder that died with the lock in place would otherwise block every
      // later launch until someone deletes the file by hand.
      if (
        reclaimStaleStartupLock(options.lockPath, {
          readFile,
          fileAgeMs,
          removeFile,
          openFileExclusive,
          closeFile,
          writeFile,
          currentPid,
          staleAfterMs,
          processAlive
        })
      ) {
        continue
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
   * Re-stamp a recorded process whose executable path changed after it was
   * recorded, without ever changing which process the record names.
   *
   * Why this exists: dev mode spawns `~/.cargo/bin/cargo`, the rustup proxy,
   * which `exec`s the toolchain cargo a few milliseconds later. `record()`
   * probes identity right after spawn. On Linux that probe is an instant
   * `/proc/<pid>/exe` readlink and captures the proxy path; the next launch
   * then sees the toolchain path, calls it an identity mismatch, and never
   * signals the process (the `smoke:backend-single-instance` timeout on the
   * ogre box, 2026-09-24). On macOS the `ps` probe is slow enough that the
   * exec has usually happened. Calling this at READY closes the race on both.
   *
   * The birth token (kernel start time) survives `exec`, so it is the only
   * thing that must match. Any other change means the PID was reused and the
   * record is left untouched.
   */
  refreshIdentity(pid: number | undefined, label: string): 'refreshed' | 'unchanged' | 'skipped' {
    if (!validPid(pid) || pid === this.currentPid) {
      return 'skipped'
    }
    const records = this.readRecords()
    const record = records.find((candidate) => candidate.pid === pid)
    if (!record?.identity) {
      return 'skipped'
    }
    const probe = this.probeForRegistration(pid)
    if (probe.state !== 'live') {
      return 'skipped'
    }
    if (probe.identity.birthToken !== record.identity.birthToken) {
      return 'skipped'
    }
    if (probe.identity.executablePath === record.identity.executablePath) {
      return 'unchanged'
    }
    this.writeRecords(
      records.map((candidate) =>
        candidate.pid === pid ? { ...candidate, label, identity: probe.identity } : candidate
      )
    )
    return 'refreshed'
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

  /**
   * Signal one ledger-authenticated process only after revalidating its birth
   * identity. Callers retain the ledger and confirm death separately; signal
   * acceptance is not exit evidence.
   */
  signalRecordedOwnership(pid: number, signal: NodeJS.Signals): RecordedProcessSignalResult {
    const ownership = this.probeRecordedOwnership(pid)
    if (ownership !== 'owned') {
      return ownership
    }
    try {
      this.killProcess(pid, signal)
      return 'signalled'
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
      return code === 'ESRCH' ? 'gone' : 'unconfirmed'
    }
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
      const statBefore = readFileSync(`/proc/${pid}/stat`, 'utf8')
      if (linuxProcessStatIsDead(statBefore)) {
        // A zombie still answers kill(pid, 0) and keeps its /proc entry until
        // the parent waits on it, but it can never run again. Its exe link is
        // already gone, so without this check it would read as unprobeable
        // and block replacement startup forever.
        return { state: 'dead' }
      }
      const before = linuxProcessBirthToken(statBefore)
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

/** Fields of `/proc/<pid>/stat` after the parenthesised command. */
function linuxProcessStatFields(stat: string): string[] | undefined {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) {
    return undefined
  }
  return stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
}

/** The process state letter (stat field 3): R, S, D, Z, T, X, … */
export function linuxProcessStatState(stat: string): string | undefined {
  return linuxProcessStatFields(stat)?.[0]
}

/** Zombie (`Z`) and dead (`X`) processes can never run again. */
export function linuxProcessStatIsDead(stat: string): boolean {
  const state = linuxProcessStatState(stat)
  return state === 'Z' || state === 'X'
}

export function linuxProcessBirthToken(stat: string): string | undefined {
  // Fields after the command begin at stat field 3 (state); starttime is field
  // 22, therefore index 19 in this suffix.
  return linuxProcessStatFields(stat)?.[19]
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
  const script = [
    `$target = Get-Process -Id ${pid} -ErrorAction Stop`,
    '$identity = [PSCustomObject]@{ birthToken = $target.StartTime.ToUniversalTime().Ticks.ToString(); executablePath = $target.Path }',
    '$identity | ConvertTo-Json -Compress'
  ].join('; ')
  for (const powershell of windowsPowerShellExecutables()) {
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
      // Try the other installed PowerShell host before marking a live PID as
      // unprobeable. Windows images frequently have both hosts but only one
      // is allowed to start from a packaged Electron process.
    }
  }
  return exactProcessIsAlive(pid) ? { state: 'unprobeable' } : { state: 'dead' }
}

/**
 * GitHub's Windows images and locked-down endpoints can ship PowerShell 7
 * without the legacy WindowsPowerShell executable on PATH. PID identity is a
 * safety boundary, so probe the known legacy location first and then use the
 * supported PowerShell 7 command instead of treating a healthy child as
 * unprobeable and killing it.
 */
function windowsPowerShellExecutables(): string[] {
  const systemRoot = process.env.SystemRoot?.trim()
  const legacy = systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : undefined
  const programFiles = process.env.ProgramFiles?.trim()
  const powerShell7 = programFiles ? join(programFiles, 'PowerShell', '7', 'pwsh.exe') : undefined
  return Array.from(
    new Set([legacy, powerShell7, 'pwsh.exe'].filter((path): path is string => Boolean(path)))
  ).filter((path) => path === 'pwsh.exe' || existsSync(path))
}

function exactProbeExecOptions(): {
  encoding: 'utf8'
  timeout: number
  maxBuffer: number
  windowsHide: true
} {
  return { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true }
}

type StartupLockIo = {
  readFile: (path: string) => string
  fileAgeMs: (path: string) => number | null
  removeFile: RemoveFile
  openFileExclusive: OpenExclusiveFile
  closeFile: CloseFile
  writeFile: (path: string, contents: string) => void
  currentPid: number
  staleAfterMs: number
  processAlive: (pid: number) => boolean
}

/**
 * What a lock path holds now, or null when that cannot be told: only ENOENT
 * proves a read found nothing (a live lock can fail to read with EACCES,
 * EPERM, EBUSY or EIO), and a path that exists for `open` but neither reads
 * nor stats (a dangling link) is no evidence either. Inconclusive is never
 * stale; the caller waits out its bounded retry instead.
 */
function inspectStartupLock(
  lockPath: string,
  io: StartupLockIo
): { contents: string | null; ageMs: number | null } | null {
  let contents: string | null
  try {
    contents = io.readFile(lockPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') return null
    contents = null
  }
  const ageMs = io.fileAgeMs(lockPath)
  if (contents === null && ageMs === null) return null
  return { contents, ageMs }
}

/** Guards of guards: each level only exists when a reclaimer crashed. */
const MAX_RECLAIM_DEPTH = 3

/**
 * Takes the reclaim guard beside a lock. Only the guard holder removes a
 * stale lock, and it re-reads the lock under the guard, so two contenders
 * that both judged the same lock stale cannot remove the replacement the
 * first one created. A guard left by a reclaimer that crashed inside this
 * window is judged like a lock (dead pid, or no pid and old) and reclaimed
 * the same way, under its own guard, so two contenders that both judged the
 * same crashed guard cannot remove the replacement guard either.
 */
function takeReclaimGuard(guardPath: string, io: StartupLockIo, depth: number): number | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fileDescriptor = io.openFileExclusive(guardPath)
      try {
        io.writeFile(guardPath, `${JSON.stringify({ pid: io.currentPid, token: randomUUID() })}\n`)
      } catch {
        // The guard still excludes others without its pid; it ages out.
      }
      return fileDescriptor
    } catch (error) {
      if (errorCode(error) !== 'EEXIST' || attempt > 0) return null
      if (!reclaimStaleStartupLock(guardPath, io, depth + 1)) return null
    }
  }
  return null
}

function reclaimStaleStartupLock(lockPath: string, io: StartupLockIo, depth = 0): boolean {
  if (depth >= MAX_RECLAIM_DEPTH) {
    return false
  }
  const observed = inspectStartupLock(lockPath, io)
  if (!observed || !startupLockIsStale(observed.contents, observed.ageMs, io)) {
    return false
  }
  const guardPath = `${lockPath}.reclaim`
  const guard = takeReclaimGuard(guardPath, io, depth)
  if (guard === null) {
    return false
  }
  try {
    // The lock may have been reclaimed and taken again since we looked: only
    // the instance we judged, still stale, is removed.
    const current = inspectStartupLock(lockPath, io)
    if (
      !current ||
      current.contents !== observed.contents ||
      !startupLockIsStale(current.contents, current.ageMs, io)
    ) {
      return false
    }
    io.removeFile(lockPath)
    return true
  } catch {
    return false
  } finally {
    try {
      io.closeFile(guard)
    } catch {
      // Best effort.
    }
    try {
      io.removeFile(guardPath)
    } catch {
      // A guard left behind is reclaimed like a lock (see takeReclaimGuard).
    }
  }
}

function sleepSync(delayMs: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
}
