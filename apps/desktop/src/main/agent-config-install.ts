import { execFile as childExecFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants, promises as fsPromises } from 'node:fs'
import { posix, win32 } from 'node:path'

import {
  AGENT_SERVER_NAME,
  agentClaudeCodeAddArgs,
  agentCodexTomlLines,
  agentJsonRootKey,
  agentJsonServerEntry,
  type AgentJsonConfigApp
} from '../shared/agent-config-entry'
import type { AgentAddApp, AgentAddResult } from '../shared/backend'
import { mergeCodexToml } from './agent-config-toml'

// Plan 209 S22: "Add to …" in the Connect dialog. Electron main writes the
// `videorc` entry into Claude Desktop's, Cursor's, VS Code's or Codex's own
// config file, or runs `claude mcp add` for Claude Code, so the streamer
// doesn't paste anything.
//
// The rules, because these files belong to other apps:
// - parse first, and add or replace only the `videorc` entry; every other
//   server and setting stays as it was;
// - never create the app's folder: no folder means the app isn't set up on
//   this computer, and the dialog's line is the way;
// - any file Videorc can't read with certainty (not plain JSON, an unknown
//   shape, TOML the scanner refuses) is left alone, and the answer says to
//   copy the line instead;
// - a timestamped backup beside the file before every change, and the new
//   file written beside it and renamed over it (a crash leaves the old file
//   or the new one, never half of one), keeping its permissions; a new file
//   is owner-only, since it holds the agent's token;
// - a symlinked config (dotfiles) is written through to its target.

/** `claude mcp add` gets this long; the CLI answers in well under a second. */
export const CLAUDE_CLI_TIMEOUT_MS = 20_000

const APP_NAMES: Record<AgentAddApp, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  'vs-code': 'VS Code'
}

/** What to do next in each app, after "Added." */
const ADDED: Record<AgentAddApp, string> = {
  'claude-desktop': 'Added. Restart Claude Desktop to see Videorc.',
  'claude-code': 'Added. Start a new Claude Code session to see Videorc.',
  cursor: 'Added. Turn on videorc in Cursor Settings → MCP to see Videorc.',
  codex: 'Added. Restart Codex to see Videorc.',
  'vs-code': 'Added. In VS Code, start videorc from MCP: List Servers to see Videorc.'
}

export function agentAddedMessage(app: AgentAddApp): string {
  return ADDED[app]
}

export const AGENT_ADD_BRIDGE_MISSING =
  "This copy of Videorc is missing its agent bridge, so agents can't connect. Reinstall Videorc, then try again."

export type AgentConfigApp = Exclude<AgentAddApp, 'claude-code'>

export interface AgentConfigEnvironment {
  platform: NodeJS.Platform
  homeDir: string
  /** `%APPDATA%` (Windows). */
  appData?: string
  /** `$XDG_CONFIG_HOME` (Linux). */
  xdgConfigHome?: string
  /** `$CODEX_HOME`, where Codex keeps config.toml when it is set. */
  codexHome?: string
}

export interface AgentConfigTarget {
  app: AgentConfigApp
  file: string
  format: 'json' | 'toml'
}

const pathFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** Where each app keeps its user-wide MCP servers on this platform. */
export function agentConfigTarget(
  app: AgentConfigApp,
  environment: AgentConfigEnvironment
): AgentConfigTarget {
  const { platform, homeDir } = environment
  const path = pathFor(platform)
  const roaming = environment.appData || path.join(homeDir, 'AppData', 'Roaming')
  const xdg = environment.xdgConfigHome || path.join(homeDir, '.config')
  // The folder each app keeps its settings in: macOS Application Support,
  // Windows %APPDATA%, Linux $XDG_CONFIG_HOME.
  const settingsRoot =
    platform === 'darwin'
      ? path.join(homeDir, 'Library', 'Application Support')
      : platform === 'win32'
        ? roaming
        : xdg
  switch (app) {
    case 'claude-desktop':
      return {
        app,
        format: 'json',
        file: path.join(settingsRoot, 'Claude', 'claude_desktop_config.json')
      }
    case 'cursor':
      return { app, format: 'json', file: path.join(homeDir, '.cursor', 'mcp.json') }
    case 'vs-code':
      return { app, format: 'json', file: path.join(settingsRoot, 'Code', 'User', 'mcp.json') }
    case 'codex':
      return {
        app,
        format: 'toml',
        file: path.join(environment.codexHome || path.join(homeDir, '.codex'), 'config.toml')
      }
  }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type JsonConfigMerge =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: 'not-json' | 'not-object' | 'servers-not-object' }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file's own indent (two spaces when it has none). */
function detectIndent(text: string): string | number {
  const match = /\n([ \t]+)\S/.exec(text)
  return match ? match[1] : 2
}

/**
 * Put `entry` under `rootKey.videorc` in `existing` (null: no file yet).
 * Other keys keep their order and values; `videorc` keeps its place when it
 * was already there.
 */
export function mergeJsonConfig(
  existing: string | null,
  rootKey: 'mcpServers' | 'servers',
  entry: Record<string, unknown>
): JsonConfigMerge {
  const body = existing?.startsWith('﻿') ? existing.slice(1) : existing
  if (body === null || body === undefined || body.trim() === '') {
    return {
      ok: true,
      text: `${JSON.stringify({ [rootKey]: { [AGENT_SERVER_NAME]: entry } }, null, 2)}\n`,
      changed: true
    }
  }
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    // Comments and trailing commas (JSONC) too: rewriting would drop them.
    return { ok: false, reason: 'not-json' }
  }
  if (!isPlainObject(root)) return { ok: false, reason: 'not-object' }
  const servers = root[rootKey] ?? {}
  if (!isPlainObject(servers)) return { ok: false, reason: 'servers-not-object' }
  if (JSON.stringify(servers[AGENT_SERVER_NAME]) === JSON.stringify(entry)) {
    return { ok: true, text: existing ?? '', changed: false }
  }
  const merged = { ...root, [rootKey]: { ...servers, [AGENT_SERVER_NAME]: entry } }
  return { ok: true, text: `${JSON.stringify(merged, null, detectIndent(body))}\n`, changed: true }
}

// ---------------------------------------------------------------------------
// Writing another app's file
// ---------------------------------------------------------------------------

/** The file system calls the install needs, so tests can fail one. */
export interface AgentConfigFs {
  stat: (path: string) => Promise<{ isDirectory: () => boolean; mode: number }>
  realpath: (path: string) => Promise<string>
  readFile: (path: string) => Promise<string>
  copyFile: (from: string, to: string, mode: number) => Promise<void>
  writeNew: (path: string, text: string, mode: number) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  rm: (path: string) => Promise<void>
  access: (path: string, mode: number) => Promise<void>
}

export const nodeAgentConfigFs: AgentConfigFs = {
  stat: (path) => fsPromises.stat(path),
  realpath: (path) => fsPromises.realpath(path),
  readFile: (path) => fsPromises.readFile(path, 'utf8'),
  copyFile: (from, to, mode) => fsPromises.copyFile(from, to, mode),
  async writeNew(path, text, mode) {
    const handle = await fsPromises.open(path, 'wx', mode)
    try {
      await handle.writeFile(text, 'utf8')
      // The umask may have narrowed the mode; the file keeps the old one's.
      await handle.chmod(mode)
      await handle.sync()
    } finally {
      await handle.close()
    }
  },
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (path) => fsPromises.rm(path, { force: true }),
  access: (path, mode) => fsPromises.access(path, mode)
}

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

/** `20261027-221530`, in UTC, for the backup's name. */
export function backupStamp(now: Date): string {
  const iso = now.toISOString()
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

/** A copy of `file` beside it, never over an earlier backup. */
async function backUp(fs: AgentConfigFs, file: string, now: Date): Promise<string> {
  const base = `${file}.videorc-backup-${backupStamp(now)}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    try {
      await fs.copyFile(file, candidate, fsConstants.COPYFILE_EXCL)
      return candidate
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
  throw new Error(`Too many backups of ${file} this second.`)
}

/** Write `text` beside `file`, then rename it over `file`. */
async function replaceAtomically(
  fs: AgentConfigFs,
  file: string,
  text: string,
  mode: number,
  platform: NodeJS.Platform
): Promise<void> {
  const path = pathFor(platform)
  const staging = path.join(
    path.dirname(file),
    `.${path.basename(file)}.videorc-${randomBytes(6).toString('hex')}.tmp`
  )
  await fs.writeNew(staging, text, mode)
  try {
    await fs.rename(staging, file)
  } catch (error) {
    await fs.rm(staging).catch(() => undefined)
    throw error
  }
}

export interface AgentConfigInstallDeps {
  fs?: AgentConfigFs
  now?: () => Date
  /** Raw causes go to main's log, never to the dialog. */
  log?: (message: string) => void
}

export type AgentConfigWrite =
  | { outcome: 'added'; file: string; backup: string | null }
  | { outcome: 'unchanged'; file: string }
  | {
      outcome: 'refused'
      file: string
      reason: 'no-app' | 'not-json' | 'not-object' | 'servers-not-object' | 'unsafe-toml'
    }
  | { outcome: 'failed'; file: string }

/** Add or replace the `videorc` entry in `target`'s file. */
export async function writeAgentConfig(
  target: AgentConfigTarget,
  connection: { bridgePath: string; token: string },
  platform: NodeJS.Platform,
  deps: AgentConfigInstallDeps = {}
): Promise<AgentConfigWrite> {
  const fs = deps.fs ?? nodeAgentConfigFs
  const log = deps.log ?? (() => undefined)
  const path = pathFor(platform)
  try {
    const folder = await fs.stat(path.dirname(target.file)).catch(() => null)
    if (!folder?.isDirectory()) return { outcome: 'refused', file: target.file, reason: 'no-app' }

    // A symlinked config is written through to the file it points at.
    let file = target.file
    let existing: string | null = null
    let mode = 0o600
    try {
      file = await fs.realpath(target.file)
      existing = await fs.readFile(file)
      mode = (await fs.stat(file)).mode & 0o777
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      file = target.file
      existing = null
    }

    let merged: { text: string; changed: boolean }
    if (target.format === 'json') {
      const app = target.app as AgentJsonConfigApp
      const result = mergeJsonConfig(
        existing,
        agentJsonRootKey(app),
        agentJsonServerEntry(app, connection)
      )
      if (!result.ok) return { outcome: 'refused', file, reason: result.reason }
      merged = result
    } else {
      const result = mergeCodexToml(existing, agentCodexTomlLines(connection), AGENT_SERVER_NAME)
      if (!result.ok) {
        log(`Left ${file} alone: it has ${result.reason}.`)
        return { outcome: 'refused', file, reason: 'unsafe-toml' }
      }
      merged = result
    }
    if (!merged.changed) return { outcome: 'unchanged', file }

    const backup =
      existing === null ? null : await backUp(fs, file, (deps.now ?? (() => new Date()))())
    await replaceAtomically(fs, file, merged.text, mode, platform)
    return { outcome: 'added', file, backup }
  } catch (error) {
    log(
      `Couldn't add Videorc to ${target.file}: ${error instanceof Error ? error.message : String(error)}`
    )
    return { outcome: 'failed', file: target.file }
  }
}

/** The dialog's sentence for a config write. */
export function agentConfigWriteMessage(app: AgentConfigApp, write: AgentConfigWrite): string {
  const name = APP_NAMES[app]
  const file = pathFor(write.file.includes('\\') ? 'win32' : 'linux').basename(write.file)
  switch (write.outcome) {
    case 'added':
    case 'unchanged':
      return ADDED[app]
    case 'failed':
      return `Couldn't add Videorc to ${name}. Copy the line instead.`
    case 'refused':
      switch (write.reason) {
        case 'no-app':
          return `Videorc can't find ${name}'s settings folder on this computer. Open ${name} once, or copy the line instead.`
        case 'not-json':
          return `${name}'s ${file} isn't plain JSON, so Videorc left it alone. Copy the line instead.`
        case 'not-object':
        case 'servers-not-object':
          return `${name}'s ${file} has a shape Videorc doesn't know, so Videorc left it alone. Copy the line instead.`
        case 'unsafe-toml':
          return `Videorc couldn't safely edit ${name}'s ${file}, so it left it alone. Copy the line instead.`
      }
  }
}

// ---------------------------------------------------------------------------
// Claude Code: the `claude` CLI
// ---------------------------------------------------------------------------

export type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; windowsHide: boolean }
) => Promise<{ stdout: string; stderr: string }>

/** `execFile` with no shell, a timeout, and stdin closed at once. */
export const nodeExecFile: ExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = childExecFile(
      file,
      args,
      { ...options, encoding: 'utf8' },
      (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })
    )
    child.stdin?.end()
  })

export interface ClaudeCliEnvironment {
  platform: NodeJS.Platform
  homeDir: string
  /** `process.env.PATH` (`Path` on Windows). */
  pathVariable: string | undefined
}

/**
 * Where `claude` may be: the PATH Electron was started with, then the
 * installers' own folders, which a Finder-launched app's PATH lacks (the
 * native installer's `~/.local/bin`, Homebrew, npm in `/usr/local`). On
 * Windows only `claude.exe` counts: Node runs a `.cmd` only through a shell.
 */
export function claudeCliCandidates(environment: ClaudeCliEnvironment): string[] {
  const { platform, homeDir } = environment
  const path = pathFor(platform)
  const separator = platform === 'win32' ? ';' : ':'
  const fromPath = (environment.pathVariable ?? '')
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && path.isAbsolute(entry))
  const extra =
    platform === 'win32'
      ? [path.join(homeDir, '.local', 'bin')]
      : [
          path.join(homeDir, '.local', 'bin'),
          path.join(homeDir, '.claude', 'local'),
          '/opt/homebrew/bin',
          '/usr/local/bin'
        ]
  const name = platform === 'win32' ? 'claude.exe' : 'claude'
  return [...new Set([...fromPath, ...extra])].map((folder) => path.join(folder, name))
}

/** The PATH `claude` runs with: its own folder and the installers' first, so its `node` resolves. */
export function claudeCliPath(cli: string, environment: ClaudeCliEnvironment): string {
  const path = pathFor(environment.platform)
  const separator = environment.platform === 'win32' ? ';' : ':'
  const folders = claudeCliCandidates(environment).map((candidate) => path.dirname(candidate))
  return [...new Set([path.dirname(cli), ...folders])].join(separator)
}

export interface ClaudeCodeInstallDeps {
  fs?: Pick<AgentConfigFs, 'access'>
  execFile?: ExecFile
  log?: (message: string) => void
  baseEnv?: NodeJS.ProcessEnv
}

export type ClaudeCodeInstall =
  | { outcome: 'added'; cli: string }
  | { outcome: 'no-cli' }
  | { outcome: 'failed'; cli: string }

export async function findClaudeCli(
  environment: ClaudeCliEnvironment,
  fs: Pick<AgentConfigFs, 'access'> = nodeAgentConfigFs
): Promise<string | null> {
  const mode = environment.platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK
  for (const candidate of claudeCliCandidates(environment)) {
    try {
      await fs.access(candidate, mode)
      return candidate
    } catch {
      // Not here; try the next folder.
    }
  }
  return null
}

/**
 * `claude mcp remove` (an earlier videorc, which `add` would refuse), then
 * `claude mcp add --scope user videorc …`: the same command the dialog shows.
 */
export async function addToClaudeCode(
  connection: { bridgePath: string; token: string },
  environment: ClaudeCliEnvironment,
  deps: ClaudeCodeInstallDeps = {}
): Promise<ClaudeCodeInstall> {
  const log = deps.log ?? (() => undefined)
  const run = deps.execFile ?? nodeExecFile
  const cli = await findClaudeCli(environment, deps.fs)
  if (!cli) return { outcome: 'no-cli' }
  const env = {
    ...(deps.baseEnv ?? process.env),
    PATH: claudeCliPath(cli, environment)
  }
  const options = { timeout: CLAUDE_CLI_TIMEOUT_MS, env, windowsHide: true }
  try {
    await run(cli, ['mcp', 'remove', '--scope', 'user', AGENT_SERVER_NAME], options)
  } catch {
    // Nothing to remove: the usual case.
  }
  try {
    await run(cli, agentClaudeCodeAddArgs(connection), options)
    return { outcome: 'added', cli }
  } catch (error) {
    // Never the arguments: they hold the token.
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : ''
    const killed =
      typeof error === 'object' && error !== null && 'killed' in error && Boolean(error.killed)
    log(
      `claude mcp add didn't finish${killed ? ' (timed out)' : ''}${stderr ? `: ${stderr.slice(0, 400)}` : ''}`
    )
    return { outcome: 'failed', cli }
  }
}

export function claudeCodeInstallMessage(install: ClaudeCodeInstall): string {
  switch (install.outcome) {
    case 'added':
      return ADDED['claude-code']
    case 'no-cli':
      return "Videorc can't find Claude Code's claude command on this computer. Run the line in a terminal instead."
    case 'failed':
      return "Claude Code didn't add Videorc. Run the line in a terminal instead."
  }
}

// ---------------------------------------------------------------------------
// The IPC's one entry point
// ---------------------------------------------------------------------------

export interface AgentAddEnvironment extends AgentConfigEnvironment {
  pathVariable: string | undefined
}

/** "Add to …": write the app's config (or run the CLI), and say what happened. */
export async function addAgentToApp(
  app: AgentAddApp,
  connection: { bridgePath: string; token: string },
  environment: AgentAddEnvironment,
  deps: AgentConfigInstallDeps & ClaudeCodeInstallDeps = {}
): Promise<AgentAddResult> {
  if (app === 'claude-code') {
    const install = await addToClaudeCode(connection, environment, deps)
    return { added: install.outcome === 'added', message: claudeCodeInstallMessage(install) }
  }
  const write = await writeAgentConfig(
    agentConfigTarget(app, environment),
    connection,
    environment.platform,
    deps
  )
  return {
    added: write.outcome === 'added' || write.outcome === 'unchanged',
    message: agentConfigWriteMessage(app, write)
  }
}
