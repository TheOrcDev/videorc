import { constants as fsConstants, promises as fsPromises } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { AgentBridgeInfo } from '../shared/backend'

// Plan 209 S7 (D6, D20): where `videorc-mcp`, the stdio bridge an agent app
// runs, lives on this computer. Settings → Remote → Agents shows that path in
// the line the streamer pastes into Claude Desktop, Cursor, Codex and the
// rest, so it must be absolute and must stay put:
// - macOS and Windows point at the app's own copy (`Contents/Resources`,
//   the per-user install's `resources\`), which an update replaces in place;
// - Linux copies it out of the AppImage, whose mount path changes every
//   launch, to `~/.local/share/videorc/bin/videorc-mcp`, and refreshes that
//   copy after an update (`refreshAgentBridgeCopy`, at startup);
// - development points at the cargo build in the repo.

export const AGENT_BRIDGE_FILE = 'videorc-mcp'

export interface AgentBridgeLocation {
  packaged: boolean
  platform: NodeJS.Platform
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** The repo root in development. */
  workspaceRoot: string
  /** The dev backend's cargo profile (`debug` unless asked otherwise). */
  cargoProfile: 'debug' | 'release'
  homeDir: string
}

/** The file system calls the bridge needs, so tests can run without a disk. */
export interface AgentBridgeFs {
  access: (path: string, mode: number) => Promise<void>
  readFile: (path: string) => Promise<Buffer>
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<unknown>
  copyFile: (from: string, to: string) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  rm: (path: string, options: { force: true }) => Promise<void>
}

const nodeFs: AgentBridgeFs = {
  access: (path, mode) => fsPromises.access(path, mode),
  readFile: (path) => fsPromises.readFile(path),
  mkdir: (path, options) => fsPromises.mkdir(path, options),
  copyFile: (from, to) => fsPromises.copyFile(from, to),
  chmod: (path, mode) => fsPromises.chmod(path, mode),
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (path, options) => fsPromises.rm(path, options)
}

const pathFor = (platform: NodeJS.Platform): typeof posix => (platform === 'win32' ? win32 : posix)

/** The bridge inside this install (or the repo's cargo build in development). */
export function bundledAgentBridgePath(location: AgentBridgeLocation): string {
  const path = pathFor(location.platform)
  const file = location.platform === 'win32' ? `${AGENT_BRIDGE_FILE}.exe` : AGENT_BRIDGE_FILE
  return location.packaged
    ? path.join(location.resourcesPath, file)
    : path.join(location.workspaceRoot, 'target', location.cargoProfile, file)
}

/** D20: the stable copy an installed Linux app keeps outside its AppImage. */
export function linuxAgentBridgeCopyPath(homeDir: string): string {
  return posix.join(homeDir, '.local', 'share', 'videorc', 'bin', AGENT_BRIDGE_FILE)
}

/** Only the packaged Linux app moves every launch; development runs from the repo. */
export function agentBridgeUsesCopy(location: AgentBridgeLocation): boolean {
  return location.packaged && location.platform === 'linux'
}

async function isRunnable(
  fs: AgentBridgeFs,
  path: string,
  platform: NodeJS.Platform
): Promise<boolean> {
  try {
    // Windows has no execute bit: a readable .exe is a runnable one.
    await fs.access(path, platform === 'win32' ? fsConstants.R_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function sameBytes(fs: AgentBridgeFs, left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fs.readFile(left), fs.readFile(right)])
    return a.equals(b)
  } catch {
    return false
  }
}

/**
 * Put the bundled bridge at `copy` unless an identical one is already there.
 * Written beside it and renamed over it, so an agent app running the old
 * copy keeps its file (Linux refuses to overwrite a running binary in place).
 */
export async function installAgentBridgeCopy(
  bundled: string,
  copy: string,
  fs: AgentBridgeFs = nodeFs,
  pid: number = process.pid
): Promise<'installed' | 'current'> {
  if (await sameBytes(fs, bundled, copy)) return 'current'
  await fs.mkdir(posix.dirname(copy), { recursive: true, mode: 0o755 })
  const staging = `${copy}.${pid}.tmp`
  try {
    await fs.copyFile(bundled, staging)
    await fs.chmod(staging, 0o755)
    await fs.rename(staging, copy)
  } catch (error) {
    await fs.rm(staging, { force: true }).catch(() => undefined)
    throw error
  }
  return 'installed'
}

/**
 * The path a config line names, and whether this install has the bridge.
 * `install` (Connect) also puts the Linux copy in place; reading the path
 * for Settings never writes anything.
 */
export async function resolveAgentBridge(
  location: AgentBridgeLocation,
  install: boolean,
  fs: AgentBridgeFs = nodeFs
): Promise<AgentBridgeInfo> {
  const bundled = bundledAgentBridgePath(location)
  const exists = await isRunnable(fs, bundled, location.platform)
  if (!agentBridgeUsesCopy(location)) return { path: bundled, exists }
  const copy = linuxAgentBridgeCopyPath(location.homeDir)
  if (exists && install) await installAgentBridgeCopy(bundled, copy, fs)
  return { path: copy, exists }
}

/**
 * After an update the Linux copy is the old version: refresh it, but only
 * when the streamer connected an agent (the copy exists). Never creates it.
 */
export async function refreshAgentBridgeCopy(
  location: AgentBridgeLocation,
  fs: AgentBridgeFs = nodeFs
): Promise<'installed' | 'current' | 'skipped'> {
  if (!agentBridgeUsesCopy(location)) return 'skipped'
  const bundled = bundledAgentBridgePath(location)
  const copy = linuxAgentBridgeCopyPath(location.homeDir)
  if (!(await isRunnable(fs, copy, location.platform))) return 'skipped'
  if (!(await isRunnable(fs, bundled, location.platform))) return 'skipped'
  return installAgentBridgeCopy(bundled, copy, fs)
}
