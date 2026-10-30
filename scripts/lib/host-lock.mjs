// Host-wide smoke admission. TCP ownership is authoritative; JSON is diagnostics only.
import net from 'node:net'
import os from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { AsyncLocalStorage } from 'node:async_hooks'

const repoRoot = resolve(import.meta.dirname, '../..')
const infoPath = (port) => join(os.tmpdir(), 'videorc-host-locks', `${port}.json`)
const noop = () => ({ release: async () => {} })
const live = (value) => {
  const pid = Number(value)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const number = (env, key, fallback) => {
  const value = Number(env[key] ?? fallback)
  if (!Number.isInteger(value) || value < 0) throw new Error(`Invalid ${key}: ${env[key]}`)
  return value
}
function holder(port) {
  try {
    const info = JSON.parse(readFileSync(infoPath(port), 'utf8'))
    if (live(info.pid) && info.worktree && info.script && Number.isFinite(info.startedAt)) {
      return `${info.script} in ${info.worktree} (pid ${info.pid}, ${Math.floor((Date.now() - info.startedAt) / 60000)}m held)`
    }
  } catch {
    /* Side files never decide ownership. */
  }
  return `held by an unknown process on 127.0.0.1:${port}`
}
async function tryPort(port) {
  const server = net.createServer()
  const acquired = await new Promise((resolveListen, reject) => {
    server.once('error', (error) =>
      error.code === 'EADDRINUSE'
        ? resolveListen(false)
        : reject(new Error(`Host lock cannot listen on 127.0.0.1:${port}: ${error.message}`))
    )
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolveListen(true))
  })
  if (!acquired) return null
  server.unref()
  try {
    mkdirSync(join(os.tmpdir(), 'videorc-host-locks'), { recursive: true })
    writeFileSync(
      infoPath(port),
      JSON.stringify({
        pid: process.pid,
        worktree: repoRoot,
        script: process.argv[1] ?? 'node',
        startedAt: Date.now()
      })
    )
  } catch {
    /* Informational only. */
  }
  let released = false
  return {
    port,
    async release() {
      if (released) return
      released = true
      try {
        if (JSON.parse(readFileSync(infoPath(port), 'utf8')).pid === process.pid)
          unlinkSync(infoPath(port))
      } catch {
        /* Missing or replaced side file. */
      }
      await new Promise((done) => server.close(done))
    }
  }
}
async function acquirePorts({
  ports,
  waitMs,
  pollMs = 2000,
  log = console.error,
  label,
  waitKnob
}) {
  if (process.platform === 'win32') return noop()
  const start = Date.now()
  let nextLog = 0
  for (;;) {
    for (const port of ports) {
      const lock = await tryPort(port)
      if (lock) return lock
    }
    const owners = ports.map(holder).join('; ')
    if (Date.now() - start >= waitMs)
      throw new Error(`${label}: timed out waiting for ${owners}; adjust ${waitKnob}`)
    if (Date.now() >= nextLog) {
      log(`[${label}] waiting for ${owners}`)
      nextLog = Date.now() + 30000
    }
    await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - start))))
  }
}
export function acquirePortLock({
  port,
  waitMs = 3600000,
  pollMs,
  log,
  label = 'smoke:host-lock',
  waitKnob = 'VIDEORC_SMOKE_HOST_LOCK_WAIT_MS'
}) {
  return acquirePorts({ ports: [port], waitMs, pollMs, log, label, waitKnob })
}
let smokeLock
export async function acquireHostSmokeLock({ log, env = process.env, pollMs } = {}) {
  if (process.platform === 'win32' || env.VIDEORC_SMOKE_HOST_LOCK === '0') return noop()
  if (smokeLock) return smokeLock
  if (live(env.VIDEORC_SMOKE_HOST_LOCK_HOLDER)) return noop()
  smokeLock = acquirePortLock({
    port: number(env, 'VIDEORC_SMOKE_LOCK_PORT', 47870),
    waitMs: number(env, 'VIDEORC_SMOKE_HOST_LOCK_WAIT_MS', 3600000),
    pollMs,
    log
  })
    .then((lock) => {
      process.env.VIDEORC_SMOKE_HOST_LOCK_HOLDER = String(process.pid)
      return lock
    })
    .catch((error) => {
      smokeLock = undefined
      throw error
    })
  return smokeLock
}
const buildContext = new AsyncLocalStorage()
let activeBuilds = 0
let previousBuildHolder
export async function withBuildSlot(fn, { log, env = process.env, pollMs } = {}) {
  const count = number(env, 'VIDEORC_SMOKE_BUILD_SLOTS', 2)
  if (
    process.platform === 'win32' ||
    count === 0 ||
    buildContext.getStore() ||
    (live(env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER) &&
      (Number(env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER) !== process.pid || activeBuilds === 0))
  )
    return fn()
  const base = number(env, 'VIDEORC_SMOKE_LOCK_PORT', 47870)
  if (base < 1 || base + count > 65535) throw new Error('Invalid smoke build slot port range')
  const lock = await acquirePorts({
    ports: Array.from({ length: count }, (_, i) => base + i + 1),
    waitMs: number(env, 'VIDEORC_SMOKE_BUILD_SLOT_WAIT_MS', 3600000),
    pollMs,
    log,
    label: 'smoke:build-slot',
    waitKnob: 'VIDEORC_SMOKE_BUILD_SLOT_WAIT_MS'
  })
  if (activeBuilds++ === 0) previousBuildHolder = process.env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER
  process.env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER = String(process.pid)
  try {
    return await buildContext.run(true, fn)
  } finally {
    if (--activeBuilds === 0) {
      if (previousBuildHolder === undefined) delete process.env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER
      else process.env.VIDEORC_SMOKE_BUILD_SLOT_HOLDER = previousBuildHolder
    }
    await lock.release()
  }
}
export function parseDarwinMemory(pressure, free, swap) {
  const level = Number(String(pressure).trim())
  const freePercent = Number(String(free).trim())
  if (![1, 2, 4].includes(level) || !Number.isFinite(freePercent))
    throw new Error('Invalid macOS memory pressure output')
  const match = String(swap).match(/total\s*=\s*(\S+).*used\s*=\s*(\S+)/)
  return {
    level,
    freePercent,
    busy: level >= 2,
    pressure: level >= 4 ? 'critical' : level >= 2 ? 'warning' : 'normal',
    swap: match ? `${match[2]} of ${match[1]}` : 'unknown'
  }
}
export function parseAvailableMemory(available, total) {
  if (!Number.isFinite(available) || !Number.isFinite(total) || total <= 0)
    throw new Error('Invalid host memory output')
  const freePercent = (available / total) * 100
  return { freePercent, busy: freePercent < 10, pressure: freePercent < 10 ? 'warning' : 'normal' }
}
export function parseLinuxMemory(text) {
  return parseAvailableMemory(
    Number(text.match(/^MemAvailable:\s+(\d+)/m)?.[1]),
    Number(text.match(/^MemTotal:\s+(\d+)/m)?.[1])
  )
}
export function readHostMemoryPressure({ platform = process.platform } = {}) {
  if (platform === 'darwin') {
    const sysctl = (name) =>
      execFileSync('sysctl', ['-n', name], { encoding: 'utf8', timeout: 5000 })
    return parseDarwinMemory(
      sysctl('kern.memorystatus_vm_pressure_level'),
      sysctl('kern.memorystatus_level'),
      sysctl('vm.swapusage')
    )
  }
  if (platform === 'linux') return parseLinuxMemory(readFileSync('/proc/meminfo', 'utf8'))
  return parseAvailableMemory(os.freemem(), os.totalmem())
}
function topProcesses() {
  if (process.platform === 'win32') return ''
  try {
    return (
      '\nTop processes by RSS (KiB, pid, command):\n' +
      execFileSync('ps', ['-axo', 'rss=,pid=,comm='], { encoding: 'utf8', timeout: 5000 })
        .trim()
        .split('\n')
        .sort((a, b) => parseInt(b) - parseInt(a))
        .slice(0, 5)
        .join('\n')
    )
  } catch {
    return '\nTop processes unavailable.'
  }
}
export async function waitForHostMemory({
  log = console.error,
  env = process.env,
  read = readHostMemoryPressure,
  pollMs = 15000
} = {}) {
  if (env.VIDEORC_SMOKE_MEMORY_CHECK === '0') return
  const waitMs = number(env, 'VIDEORC_SMOKE_MEMORY_WAIT_MS', 600000)
  const start = Date.now()
  for (;;) {
    const state = await read()
    if (!state.busy) return
    const message = `Host busy: memory pressure ${state.pressure} (free ${Math.round(state.freePercent)}%${state.swap ? `, swap ${state.swap}` : ''})`
    log(`[smoke:memory] ${message}`)
    if (env.CI === 'true') return
    if (Date.now() - start >= waitMs)
      throw new Error(`${message}; adjust VIDEORC_SMOKE_MEMORY_WAIT_MS${topProcesses()}`)
    await delay(Math.min(pollMs, Math.max(1, waitMs - (Date.now() - start))))
  }
}
