import { constants as fsConstants, promises as fsPromises } from 'node:fs'
import { posix, win32 } from 'node:path'

import type { AgentBridgeInfo } from '../shared/backend'

// Plan 209 S7 (D6, D20): where `videorc-mcp`, the stdio bridge an agent app
// runs, lives on this computer. Settings → Remote → Agents shows that path in
// the line the streamer pastes into Claude Desktop, Cursor, Codex and the
// rest, so it must be absolute and must stay put:
// - macOS points at the app's own copy (`Contents/Resources`), which an
//   update replaces in place;
// - Linux copies it out of the AppImage, whose mount path changes every
//   launch, to `~/.local/share/videorc/bin/videorc-mcp`;
// - Windows copies it out of the install to
//   `%LOCALAPPDATA%\Videorc\bin\videorc-mcp.exe` (review #8): the NSIS
//   updater and uninstaller close every process running from `$INSTDIR`, so
//   an agent app's bridge inside it would be killed by every update, and a
//   running bridge would lock the uninstall;
// - both copies are refreshed after an update (`refreshAgentBridgeCopy`, at
//   startup);
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
  /** `%LOCALAPPDATA%` (Windows); `<home>\AppData\Local` when unset. */
  localAppData?: string
  /** `process.execPath`: the Windows copy records it beside itself, so the
   * bridge can open a Videorc installed to a folder of the streamer's choosing. */
  appExecutable?: string
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
  writeFile: (path: string, text: string) => Promise<void>
}

const nodeFs: AgentBridgeFs = {
  access: (path, mode) => fsPromises.access(path, mode),
  readFile: (path) => fsPromises.readFile(path),
  mkdir: (path, options) => fsPromises.mkdir(path, options),
  copyFile: (from, to) => fsPromises.copyFile(from, to),
  chmod: (path, mode) => fsPromises.chmod(path, mode),
  rename: (from, to) => fsPromises.rename(from, to),
  rm: (path, options) => fsPromises.rm(path, options),
  writeFile: (path, text) => fsPromises.writeFile(path, text, 'utf8')
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

/** Review #8: the stable copy a Windows install keeps outside `$INSTDIR`. */
export function windowsAgentBridgeCopyPath(homeDir: string, localAppData?: string): string {
  const local = localAppData || win32.join(homeDir, 'AppData', 'Local')
  return win32.join(local, 'Videorc', 'bin', `${AGENT_BRIDGE_FILE}.exe`)
}

/** Beside the Windows copy: the Videorc.exe that last refreshed it, one line. */
export const AGENT_BRIDGE_APP_POINTER = 'videorc-app-path.txt'

/** The packaged Linux and Windows apps keep a copy; development runs from the repo. */
export function agentBridgeUsesCopy(location: AgentBridgeLocation): boolean {
  return location.packaged && (location.platform === 'linux' || location.platform === 'win32')
}

/** The path config lines name: the copy where there is one, else the bundled bridge. */
export function agentBridgeCopyPath(location: AgentBridgeLocation): string {
  return location.platform === 'win32'
    ? windowsAgentBridgeCopyPath(location.homeDir, location.localAppData)
    : linuxAgentBridgeCopyPath(location.homeDir)
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

/** Windows refuses to replace or delete a running .exe with these. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

/**
 * Put the bundled bridge at `copy` unless an identical one is already there.
 * Written beside it and renamed over it, so an agent app running the old
 * copy keeps its file (Linux refuses to overwrite a running binary in place).
 *
 * Windows can't replace a running .exe, but it can rename one: the running
 * copy moves aside to `<copy>.old` (removed once nothing runs it), and the
 * new one takes its name. When even that fails, the old copy stays and the
 * answer is `busy`: it still works, and the next start tries again.
 */
export async function installAgentBridgeCopy(
  bundled: string,
  copy: string,
  fs: AgentBridgeFs = nodeFs,
  pid: number = process.pid,
  platform: NodeJS.Platform = process.platform
): Promise<'installed' | 'current' | 'busy'> {
  const aside = `${copy}.old`
  // A copy an agent app was still running at the last swap.
  if (platform === 'win32') await fs.rm(aside, { force: true }).catch(() => undefined)
  if (await sameBytes(fs, bundled, copy)) return 'current'
  await fs.mkdir(pathFor(platform).dirname(copy), { recursive: true, mode: 0o755 })
  const staging = `${copy}.${pid}.tmp`
  const dropStaging = (): Promise<void> => fs.rm(staging, { force: true }).catch(() => undefined)
  try {
    await fs.copyFile(bundled, staging)
    await fs.chmod(staging, 0o755)
    await fs.rename(staging, copy)
    return 'installed'
  } catch (error) {
    if (platform !== 'win32' || !BUSY_CODES.has(errorCode(error) ?? '')) {
      await dropStaging()
      throw error
    }
  }
  try {
    await fs.rename(copy, aside)
  } catch {
    await dropStaging()
    return 'busy'
  }
  try {
    await fs.rename(staging, copy)
  } catch {
    await fs.rename(aside, copy).catch(() => undefined)
    await dropStaging()
    return 'busy'
  }
  await fs.rm(aside, { force: true }).catch(() => undefined)
  return 'installed'
}

/**
 * Windows: the bridge opens Videorc for an agent's first call, and a copy
 * outside the install can't look beside itself for Videorc.exe, so the app
 * that refreshed the copy names itself in a file next to it. Written only
 * when it changed. Best effort: without it the bridge tries the default
 * per-user install.
 */
async function pointAtThisApp(
  location: AgentBridgeLocation,
  copy: string,
  fs: AgentBridgeFs
): Promise<void> {
  if (location.platform !== 'win32' || !location.appExecutable) return
  const pointer = win32.join(win32.dirname(copy), AGENT_BRIDGE_APP_POINTER)
  const line = `${location.appExecutable}\r\n`
  const current = await fs.readFile(pointer).then(
    (body) => body.toString('utf8'),
    () => null
  )
  if (current !== line) await fs.writeFile(pointer, line).catch(() => undefined)
}

/**
 * The path a config line names, and whether this install has the bridge.
 * `install` (Connect) also puts the Linux or Windows copy in place; reading
 * the path for Settings never writes anything.
 */
export async function resolveAgentBridge(
  location: AgentBridgeLocation,
  install: boolean,
  fs: AgentBridgeFs = nodeFs
): Promise<AgentBridgeInfo> {
  const bundled = bundledAgentBridgePath(location)
  const exists = await isRunnable(fs, bundled, location.platform)
  if (!agentBridgeUsesCopy(location)) return { path: bundled, exists }
  const copy = agentBridgeCopyPath(location)
  if (exists && install) {
    // `busy` keeps the old copy, which still runs.
    await installAgentBridgeCopy(bundled, copy, fs, process.pid, location.platform)
    await pointAtThisApp(location, copy, fs)
  }
  return { path: copy, exists }
}

/**
 * After an update the copy is the old version: refresh it, but only when
 * the streamer connected an agent (the copy exists). Never creates it.
 */
export async function refreshAgentBridgeCopy(
  location: AgentBridgeLocation,
  fs: AgentBridgeFs = nodeFs
): Promise<'installed' | 'current' | 'busy' | 'skipped'> {
  if (!agentBridgeUsesCopy(location)) return 'skipped'
  const bundled = bundledAgentBridgePath(location)
  const copy = agentBridgeCopyPath(location)
  if (!(await isRunnable(fs, copy, location.platform))) return 'skipped'
  if (!(await isRunnable(fs, bundled, location.platform))) return 'skipped'
  const result = await installAgentBridgeCopy(bundled, copy, fs, process.pid, location.platform)
  await pointAtThisApp(location, copy, fs)
  return result
}
