import { spawnSync } from 'node:child_process'

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

export function ownedTcpListenerIsReady({
  pid,
  port,
  platform = process.platform,
  spawnSyncImpl = spawnSync
}) {
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
