import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { stripAnsi } from './backend-crash-log'

// Rotating on-disk sink for backend stderr + supervisor lifecycle lines.
//
// Packaged builds have no terminal: before this file every backend stderr line
// went to the main-process console (nowhere) and a 200-line in-memory ring
// that died with the app, so a Windows tester's bundle after a crash loop
// carried only the current generation's lines. `userData/logs/backend.log`
// keeps the last ~4 MB (2 files × 2 MB) across restarts and relaunches.
//
// Writes are synchronous appends: the volume is log-line sized, the main
// thread already serialises these lines to the console, and a sync write is
// the only kind guaranteed to land before a crash takes the process down.

export const BACKEND_LOG_FILE_MAX_BYTES = 2 * 1024 * 1024
export const BACKEND_LOG_FILE_MAX_FILES = 2

export function backendLogFilePath(userDataDir: string): string {
  return join(userDataDir, 'logs', 'backend.log')
}

export function formatBackendLogFileLine(
  level: string,
  message: string,
  timestamp: string
): string {
  return `${timestamp} [${level}] ${stripAnsi(message).replace(/\r?\n/g, '\\n')}\n`
}

export interface RotatingLogFileFs {
  appendFile?: (path: string, contents: string) => void
  sizeOf?: (path: string) => number | null
  rename?: (from: string, to: string) => void
  remove?: (path: string) => void
  makeDir?: (path: string) => void
}

export interface RotatingLogFileOptions {
  path: string
  maxBytes?: number
  maxFiles?: number
  fs?: RotatingLogFileFs
  /** Called once, on the first failure; the sink then disables itself so a
   * broken disk never turns every log line into a second error. */
  onError?: (error: unknown) => void
}

export class RotatingLogFile {
  private readonly path: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly appendFile: NonNullable<RotatingLogFileFs['appendFile']>
  private readonly sizeOf: NonNullable<RotatingLogFileFs['sizeOf']>
  private readonly rename: NonNullable<RotatingLogFileFs['rename']>
  private readonly remove: NonNullable<RotatingLogFileFs['remove']>
  private readonly makeDir: NonNullable<RotatingLogFileFs['makeDir']>
  private readonly onError: (error: unknown) => void
  private currentBytes: number | null = null
  private disabled = false

  constructor({
    path,
    maxBytes = BACKEND_LOG_FILE_MAX_BYTES,
    maxFiles = BACKEND_LOG_FILE_MAX_FILES,
    fs = {},
    onError = () => {}
  }: RotatingLogFileOptions) {
    this.path = path
    this.maxBytes = Math.max(1, maxBytes)
    this.maxFiles = Math.max(1, maxFiles)
    this.appendFile = fs.appendFile ?? ((target, contents) => appendFileSync(target, contents))
    this.sizeOf =
      fs.sizeOf ??
      ((target) => {
        try {
          return statSync(target).size
        } catch {
          return null
        }
      })
    this.rename = fs.rename ?? ((from, to) => renameSync(from, to))
    this.remove = fs.remove ?? ((target) => rmSync(target, { force: true }))
    this.makeDir = fs.makeDir ?? ((target) => mkdirSync(target, { recursive: true }))
    this.onError = onError
  }

  get filePath(): string {
    return this.path
  }

  /** Names of the files this sink owns, newest first. */
  rotatedPaths(): string[] {
    const paths = [this.path]
    for (let index = 1; index < this.maxFiles; index += 1) {
      paths.push(`${this.path}.${index}`)
    }
    return paths
  }

  write(line: string): void {
    if (this.disabled || !line) {
      return
    }
    try {
      if (this.currentBytes === null) {
        this.makeDir(dirname(this.path))
        this.currentBytes = this.sizeOf(this.path) ?? 0
      }
      const bytes = Buffer.byteLength(line, 'utf8')
      if (this.currentBytes > 0 && this.currentBytes + bytes > this.maxBytes) {
        this.rotate()
      }
      this.appendFile(this.path, line)
      this.currentBytes += bytes
    } catch (error) {
      this.disabled = true
      this.onError(error)
    }
  }

  private rotate(): void {
    const paths = this.rotatedPaths()
    // Drop the oldest, shift the rest up by one, then free the live name.
    this.remove(paths[paths.length - 1])
    for (let index = paths.length - 1; index >= 2; index -= 1) {
      try {
        this.rename(paths[index - 1], paths[index])
      } catch {
        // A missing intermediate file just means fewer rotations so far.
      }
    }
    if (paths.length > 1) {
      // The live file must move: a failed rename here (Windows lock, full
      // disk) propagates so the sink disables itself explicitly instead of
      // growing one file past the budget forever.
      this.rename(paths[0], paths[1])
    }
    this.currentBytes = 0
  }
}
