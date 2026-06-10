import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface OwnedProcessRecord {
  pid: number
  label: string
  startedAt: string
}

type KillProcess = (pid: number, signal: NodeJS.Signals) => void
type Schedule = (callback: () => void, delayMs: number) => unknown

export interface OwnedProcessRegistryOptions {
  ledgerPath: string
  currentPid?: number
  platform?: NodeJS.Platform
  now?: () => string
  readFile?: (path: string) => string
  writeFile?: (path: string, contents: string) => void
  makeDir?: (path: string) => void
  killProcess?: KillProcess
  schedule?: Schedule
}

export interface ReapOwnedProcessesOptions {
  disabled?: boolean
  killGraceMs?: number
}

export function ownedProcessLedgerPath(userDataPath: string, workspaceRoot: string): string {
  const key = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16)
  return join(userDataPath, 'owned-processes', `${key}.json`)
}

export class OwnedProcessRegistry {
  private readonly currentPid: number
  private readonly platform: NodeJS.Platform
  private readonly now: () => string
  private readonly readFile: (path: string) => string
  private readonly writeFile: (path: string, contents: string) => void
  private readonly makeDir: (path: string) => void
  private readonly killProcess: KillProcess
  private readonly schedule: Schedule

  constructor(private readonly options: OwnedProcessRegistryOptions) {
    this.currentPid = options.currentPid ?? process.pid
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? (() => new Date().toISOString())
    this.readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'))
    this.writeFile = options.writeFile ?? ((path, contents) => writeFileSync(path, contents))
    this.makeDir = options.makeDir ?? ((path) => mkdirSync(path, { recursive: true }))
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  }

  record(pid: number | undefined, label: string): void {
    if (!validPid(pid) || pid === this.currentPid) {
      return
    }

    const records = this.readRecords().filter((record) => record.pid !== pid)
    records.push({ pid, label, startedAt: this.now() })
    this.writeRecords(records)
  }

  remove(pid: number | undefined): void {
    if (!validPid(pid)) {
      return
    }

    const records = this.readRecords().filter((record) => record.pid !== pid)
    this.writeRecords(records)
  }

  reapStale(options: ReapOwnedProcessesOptions = {}): OwnedProcessRecord[] {
    if (this.platform === 'win32' || options.disabled) {
      return []
    }

    const stale = dedupeRecords(
      this.readRecords().filter((record) => record.pid !== this.currentPid && validPid(record.pid))
    )
    if (stale.length === 0) {
      return []
    }

    this.writeRecords([])
    for (const record of stale) {
      this.tryKill(record.pid, 'SIGTERM')
    }

    const killGraceMs = options.killGraceMs ?? 1500
    this.schedule(() => {
      for (const record of stale) {
        this.tryKill(record.pid, 'SIGKILL')
      }
    }, killGraceMs)

    return stale
  }

  private tryKill(pid: number, signal: NodeJS.Signals): void {
    try {
      this.killProcess(pid, signal)
    } catch {
      // The process may have already exited; stale ledgers should not fail app startup.
    }
  }

  private readRecords(): OwnedProcessRecord[] {
    try {
      const parsed = JSON.parse(this.readFile(this.options.ledgerPath)) as unknown
      if (!Array.isArray(parsed)) {
        return []
      }
      return parsed.filter(isOwnedProcessRecord)
    } catch {
      return []
    }
  }

  private writeRecords(records: OwnedProcessRecord[]): void {
    this.makeDir(dirname(this.options.ledgerPath))
    this.writeFile(this.options.ledgerPath, `${JSON.stringify(records, null, 2)}\n`)
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
  return validPid(record.pid) && typeof record.label === 'string' && typeof record.startedAt === 'string'
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1
}
