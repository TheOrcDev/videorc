// Runs the Windows fixture window (scripts/fixtures/windows-fixture-window,
// issue #1088) with the repository's own Electron: launch it over one display,
// flash it white for a recording's clock anchor, and stop it by its own PID.
// The spawned PID is the fixture's Electron main process, so cleanup never
// scans for processes.

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const READY_TIMEOUT_MS = 20_000
const FLASH_TIMEOUT_MS = 1500
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const WINDOWS_FIXTURE_MAIN = join(
  repoRoot,
  'scripts',
  'fixtures',
  'windows-fixture-window',
  'main.cjs'
)

/** The Electron executable the desktop package installs. */
export function resolveElectronBinary() {
  const require = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))
  const binary = require('electron')
  if (typeof binary !== 'string' || !binary)
    throw new Error('apps/desktop has no Electron binary; run pnpm install')
  return binary
}

/**
 * Parses the fixture's ready line.
 * @returns {{pid:number, hwnd:string, bounds:{x:number,y:number,width:number,height:number}, scale:number, controlPort:number}|null}
 */
export function parseWindowsFixtureReady(line) {
  const match =
    /^ready pid=(\d+) window_number=(\d+) bounds=(-?\d+),(-?\d+),(\d+)x(\d+) scale=([\d.]+) control_port=(\d+)/.exec(
      line
    )
  if (!match) return null
  return {
    pid: Number(match[1]),
    hwnd: match[2],
    bounds: {
      x: Number(match[3]),
      y: Number(match[4]),
      width: Number(match[5]),
      height: Number(match[6])
    },
    scale: Number(match[7]),
    controlPort: Number(match[8])
  }
}

/**
 * Launches the fixture over one display and resolves once it printed its
 * ready line.
 * @param {{displayIndex?:number,color?:'red'|'blue',onLine?:(line:string)=>void}} [options]
 */
export function launchWindowsFixtureWindow({ displayIndex = 0, color = 'red', onLine } = {}) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(
      resolveElectronBinary(),
      [WINDOWS_FIXTURE_MAIN, '--display-index', String(displayIndex), '--color', color],
      { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: false }
    )
    const fixture = {
      key: 'alpha',
      name: 'Fixture Alpha (Windows)',
      color,
      pid: child.pid,
      child,
      ready: null,
      control: null,
      lines: [],
      flashWaiters: [],
      exited: null
    }
    fixture.exited = new Promise((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
      child.once('error', (error) => resolveExit({ error }))
    })
    let buffer = ''
    const timer = setTimeout(() => {
      stopWindowsFixtureWindow(fixture).catch(() => undefined)
      rejectLaunch(
        new Error(
          `${fixture.name} printed no ready line within ${READY_TIMEOUT_MS} ms: ${fixture.lines.slice(-5).join(' | ')}`
        )
      )
    }, READY_TIMEOUT_MS)
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectLaunch(error)
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      buffer += text
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line) continue
        fixture.lines.push(line)
        onLine?.(line)
        const ready = parseWindowsFixtureReady(line)
        if (ready && !fixture.ready) {
          fixture.ready = ready
          // Electron's main process gets no stdin on Windows; commands go
          // over the loopback socket the ready line names.
          const socket = connect(ready.controlPort, '127.0.0.1')
          socket.once('connect', () => {
            clearTimeout(timer)
            fixture.control = socket
            resolveLaunch(fixture)
          })
          socket.once('error', (error) => {
            if (fixture.control) return
            clearTimeout(timer)
            stopWindowsFixtureWindow(fixture).catch(() => undefined)
            rejectLaunch(new Error(`${fixture.name} control socket: ${error.message}`))
          })
        }
        const drawn = /^flash drawn_at_ms=(\d+)/.exec(line)
        if (drawn) fixture.flashWaiters.shift()?.(Number(drawn[1]))
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) fixture.lines.push(`stderr: ${line}`)
    })
  })
}

/**
 * Flashes the fixture white for `durationMs`. Resolves with the wall time the
 * first white frame was presented; falls back to the send time when the
 * fixture never reports (same shape as flashFixtureApp on macOS). The
 * default outlasts a few capture intervals, so a capture well under the
 * canvas rate still records white frames.
 */
export function flashWindowsFixtureWindow(fixture, label, { durationMs = 500 } = {}) {
  return new Promise((resolveFlash) => {
    const sentAtMs = Date.now()
    const timer = setTimeout(() => {
      fixture.flashWaiters = fixture.flashWaiters.filter((entry) => entry !== onDrawn)
      resolveFlash({ label, sentAtMs, drawnAtMs: sentAtMs, drawnReported: false })
    }, FLASH_TIMEOUT_MS)
    const onDrawn = (drawnAtMs) => {
      clearTimeout(timer)
      resolveFlash({ label, sentAtMs, drawnAtMs, durationMs, drawnReported: true })
    }
    fixture.flashWaiters.push(onDrawn)
    try {
      fixture.control.write(`flash ${Math.round(durationMs)}\n`)
    } catch (error) {
      clearTimeout(timer)
      resolveFlash({
        label,
        sentAtMs,
        drawnAtMs: sentAtMs,
        drawnReported: false,
        error: String(error)
      })
    }
  })
}

/**
 * The fixture's own frame count now, from its `stats` line.
 * @returns {Promise<{frames:number, atMs:number}|null>}
 */
export function windowsFixtureStats(fixture, { timeoutMs = 2000 } = {}) {
  return new Promise((resolveStats) => {
    const from = fixture.lines.length
    const deadline = Date.now() + timeoutMs
    const poll = () => {
      for (const line of fixture.lines.slice(from)) {
        const match = /^stats frames=(\d+) at_ms=(\d+)/.exec(line)
        if (match) return resolveStats({ frames: Number(match[1]), atMs: Number(match[2]) })
      }
      if (Date.now() > deadline) return resolveStats(null)
      setTimeout(poll, 20)
    }
    try {
      fixture.control.write('stats\n')
    } catch {
      return resolveStats(null)
    }
    poll()
  })
}

/** Asks the fixture to quit, then kills its own process tree by PID. */
export async function stopWindowsFixtureWindow(fixture, { graceMs = 3000 } = {}) {
  const { child } = fixture
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    fixture.control?.end('quit\n')
  } catch {
    // already closing
  }
  const exited = await Promise.race([
    fixture.exited.then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), graceMs))
  ])
  if (exited) return
  // Electron's renderer and GPU children hang off the main PID; /T reaps the
  // tree this fixture owns and nothing else.
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await Promise.race([
    fixture.exited,
    new Promise((resolveWait) => setTimeout(resolveWait, graceMs))
  ])
}
