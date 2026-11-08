import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, readlink, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { writeLabJson } from './config.mjs'
import { refuse } from './install-runner.mjs'
import { isLinux } from './platform.mjs'

// Plan 178 U5: put a verified Videorc.app in place and keep the one it
// replaced for --rollback.
//
// The new app is extracted into a hidden staging dir NEXT TO the target (same
// volume), verified there, then moved in with two renames. Nothing is deleted
// until the new app is in place; a failed rename restores the old app. Node
// has no rename-swap, so there is a sub-millisecond gap with no app at the
// target path, which is why an install refuses while Videorc runs from it.
//
// Plan 179: on Linux the "app" is a directory (the extracted AppImage) and the
// same two renames swap it; only the running check differs.

export const INSTALL_RECORD_FILE = 'install.json'
export const INSTALL_RECORD_SCHEMA = 1

// Videorc.app -> Videorc.previous.app (macOS); Videorc -> Videorc.previous
// (the Linux install directory).
export function previousAppPath(appPath) {
  if (!appPath.endsWith('.app')) return join(dirname(appPath), `${basename(appPath)}.previous`)
  return join(dirname(appPath), `${basename(appPath, '.app')}.previous.app`)
}

export function installRecordPath(dir) {
  return join(dir, INSTALL_RECORD_FILE)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

// Executables whose open text segment means "Videorc is running from here".
// `lsof -t <file>` names only the processes holding these exact files: no
// process-table scan, no pgrep.
export function bundleExecutables(appPath) {
  return [
    join(appPath, 'Contents', 'MacOS', basename(appPath, '.app')),
    join(appPath, 'Contents', 'Resources', 'videorc-backend')
  ]
}

export async function runningPids(runner, appPath) {
  const present = []
  for (const path of bundleExecutables(appPath)) {
    if (await exists(path)) present.push(path)
  }
  if (present.length === 0) return []
  const result = await runner('lsof', ['-t', '--', ...present])
  // lsof exits 1 with no output when nothing holds the files.
  return result.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => /^[0-9]+$/.test(value))
}

function isInside(path, dir) {
  return path === dir || path.startsWith(`${dir}/`)
}

async function listProcPids() {
  return (await readdir('/proc')).filter((name) => /^[0-9]+$/.test(name))
}

// Linux (plan 179): no lsof needed. /proc/<pid>/exe names each process's
// executable, so a process runs "from" the install dir when that link points
// inside it (videorc, its zygote and GPU children, videorc-backend, the
// bundled ffmpeg). Read-only: nothing is signalled. Processes we may not
// inspect (other users) or that exit mid-scan are skipped; the lab user's own
// Videorc is always readable.
export async function linuxRunningPids(
  appPath,
  { listProcs = listProcPids, readlink: readLink = readlink } = {}
) {
  const roots = [appPath]
  const real = await realpath(appPath).catch(() => null)
  if (real && real !== appPath) roots.push(real)
  const pids = []
  for (const pid of await listProcs()) {
    let exe
    try {
      exe = await readLink(`/proc/${pid}/exe`)
    } catch {
      continue
    }
    const path = String(exe).replace(/ \(deleted\)$/, '')
    if (roots.some((root) => isInside(path, root))) pids.push(String(pid))
  }
  return pids
}

export async function assertNotRunning(
  runner,
  appPath,
  { platform = process.platform, procfs } = {}
) {
  const pids = isLinux(platform)
    ? await linuxRunningPids(appPath, procfs)
    : await runningPids(runner, appPath)
  if (pids.length > 0) {
    refuse(
      'app-running',
      `Videorc is running from ${appPath} (pid ${pids.join(', ')}). Quit it first; live:install never replaces or deletes a running app.`
    )
  }
}

export async function createStaging(appPath) {
  const parent = dirname(appPath)
  await mkdir(parent, { recursive: true })
  const staging = join(parent, `.videorc-install-${randomBytes(6).toString('hex')}`)
  await mkdir(staging, { mode: 0o700 })
  return staging
}

// `ditto -x -k` keeps the bundle's symlinks, xattrs and signatures intact.
export async function extractZip(runner, zipPath, stagingDir, appName) {
  const target = join(stagingDir, 'extract')
  await mkdir(target)
  const result = await runner('ditto', ['-x', '-k', zipPath, target], { timeoutMs: 10 * 60_000 })
  if (result.code !== 0) {
    throw new Error(`ditto could not extract ${basename(zipPath)}: ${result.stderr.trim()}`)
  }
  const apps = (await readdir(target)).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1 || apps[0] !== appName) {
    refuse(
      'unexpected-archive',
      `The zip must hold exactly ${appName}; it holds ${apps.join(', ') || 'no app'}.`
    )
  }
  return join(target, appName)
}

// target -> previous (old previous parked in staging), staged -> target.
export async function swapIn({ stagedApp, appPath, stagingDir }) {
  const previous = previousAppPath(appPath)
  const parkedPrevious = join(stagingDir, 'parked-previous.app')
  const hadTarget = await exists(appPath)
  const hadPrevious = hadTarget && (await exists(previous))
  if (hadPrevious) await rename(previous, parkedPrevious)
  if (hadTarget) await rename(appPath, previous)
  try {
    await rename(stagedApp, appPath)
  } catch (error) {
    if (hadTarget) await rename(previous, appPath)
    if (hadPrevious) await rename(parkedPrevious, previous)
    throw error
  }
  return { keptPrevious: hadTarget }
}

// previous <-> target, through the staging dir. Rolling back twice returns
// to where you started.
export async function swapBack({ appPath, stagingDir }) {
  const previous = previousAppPath(appPath)
  if (!(await exists(previous))) {
    refuse('no-previous', `There is no ${basename(previous)} to roll back to.`)
  }
  const parked = join(stagingDir, 'rolled-out.app')
  const hadTarget = await exists(appPath)
  if (hadTarget) await rename(appPath, parked)
  try {
    await rename(previous, appPath)
  } catch (error) {
    if (hadTarget) await rename(parked, appPath)
    throw error
  }
  if (hadTarget) await rename(parked, previous)
}

export async function removeStaging(stagingDir) {
  await rm(stagingDir, { recursive: true, force: true })
}

export async function readInstallRecord(dir) {
  try {
    return JSON.parse(await readFile(installRecordPath(dir), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`${installRecordPath(dir)} is unreadable: ${error.message}`)
  }
}

export async function writeInstallRecord(dir, record) {
  await writeLabJson(dir, INSTALL_RECORD_FILE, record)
}

// One entry without its own `previous`, so the record never nests deeper
// than one level.
export function withoutPrevious(entry) {
  if (!entry) return null
  const { previous: _previous, schema: _schema, ...rest } = entry
  return rest
}
