import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'

export function lsofShowsOwnedTcpListener(output, pid, port) {
  const fields = String(output).split(/\r?\n/)
  return (
    fields.includes(`p${pid}`) &&
    fields.some((field) => field.startsWith('n') && field.slice(1).endsWith(`:${port}`))
  )
}

export function netstatShowsOwnedTcpListener(output, pid, port) {
  return String(output)
    .split(/\r?\n/)
    .some((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 5 || fields[0]?.toUpperCase() !== 'TCP') return false
      const localEndpoint = fields[1] ?? ''
      const state = fields.at(-2)?.toUpperCase()
      const ownerPid = Number(fields.at(-1))
      return localEndpoint.endsWith(`:${port}`) && state === 'LISTENING' && ownerPid === Number(pid)
    })
}

// /proc/net/tcp{,6}: the inodes of the sockets listening (state 0A) on `port`.
export function procTcpListenerInodes(tables, port) {
  const inodes = new Set()
  for (const table of tables) {
    for (const line of String(table).split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/)
      if (fields.length < 10 || fields[3] !== '0A') continue
      if (Number.parseInt(fields[1].split(':').at(-1), 16) === Number(port)) inodes.add(fields[9])
    }
  }
  return inodes
}

export function procFdLinksHoldSocket(links, inodes) {
  return links.some((link) => inodes.has(/^socket:\[(\d+)\]$/.exec(link)?.[1]))
}

const linuxProc = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readdir: (path) => readdirSync(path),
  readlink: (path) => readlinkSync(path)
}

// Linux reads /proc instead of running lsof, which Arch and minimal images
// do not ship. A missing tcp6 table means IPv6 is off; a missing fd
// directory means the child is gone, which the caller reports from its exit.
function linuxProcShowsOwnedTcpListener({ pid, port, proc }) {
  const tables = []
  for (const name of ['tcp', 'tcp6']) {
    try {
      tables.push(proc.readFile(`/proc/net/${name}`))
    } catch (error) {
      if (name === 'tcp6' && error?.code === 'ENOENT') continue
      throw new Error(`Could not inspect the local RTMP listener socket: ${error.message}`)
    }
  }
  const inodes = procTcpListenerInodes(tables, port)
  if (inodes.size === 0) return false
  let fds
  try {
    fds = proc.readdir(`/proc/${pid}/fd`)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new Error(`Could not inspect the local RTMP listener socket: ${error.message}`)
  }
  const links = []
  for (const fd of fds) {
    try {
      links.push(proc.readlink(`/proc/${pid}/fd/${fd}`))
    } catch {
      // The descriptor closed between the listing and the read.
    }
  }
  return procFdLinksHoldSocket(links, inodes)
}

export function ownedTcpListenerIsReady({
  pid,
  port,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  procImpl = linuxProc
}) {
  if (platform === 'linux') return linuxProcShowsOwnedTcpListener({ pid, port, proc: procImpl })
  const windows = platform === 'win32'
  const executable = windows ? 'netstat' : 'lsof'
  const args = windows
    ? ['-ano', '-p', 'tcp']
    : ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']
  const result = spawnSyncImpl(executable, args, {
    encoding: 'utf8',
    timeout: 1_000,
    windowsHide: true
  })
  if (result.error) {
    throw new Error(`Could not inspect the local RTMP listener socket: ${result.error.message}`)
  }
  if (result.status !== 0) {
    // lsof uses status 1 for a valid query with no matching descriptors yet.
    if (!windows && result.status === 1) return false
    throw new Error(
      `Local RTMP listener socket inspection failed (${executable} exit ${result.status}): ${String(result.stderr ?? '').trim()}`
    )
  }
  return windows
    ? netstatShowsOwnedTcpListener(result.stdout, pid, port)
    : lsofShowsOwnedTcpListener(result.stdout, pid, port)
}

export async function waitForOwnedTcpListener({
  child,
  port,
  timeoutMs,
  pollMs = 50,
  probe = ownedTcpListenerIsReady,
  diagnostics = () => ''
}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 1) {
    throw new Error('Local RTMP listener did not expose an owned process ID.')
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Local RTMP listener exited before binding port ${port}: ${String(diagnostics()).trim()}`
      )
    }
    if (probe({ pid: child.pid, port })) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
  throw new Error(
    `Local RTMP listener pid ${child.pid} did not bind port ${port} within ${timeoutMs}ms: ${String(diagnostics()).trim()}`
  )
}
