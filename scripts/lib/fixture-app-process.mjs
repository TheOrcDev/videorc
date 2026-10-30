// Runs the fixture apps scripts/fixtures/build-fixture-apps.mjs builds
// (plan 210 S0, S11): launch one by its bundled executable (the spawned PID is
// the fixture's own, so cleanup never scans for it), flash it white for the
// recording's clock anchor, bring it to the front, and read which app is in
// front. Shared by probe-scene-window-switch.mjs and smoke-smart-scenes-app.mjs.
//
// Activation goes through LaunchServices (`open <bundle>`): a running app is
// brought to the front without Accessibility or Automation grants, and the
// front app is read with `lsappinfo`, which needs none either.

import { execFile, spawn } from 'node:child_process'

const READY_TIMEOUT_MS = 15_000
const FLASH_TIMEOUT_MS = 1500

/**
 * Launches one fixture app and resolves once it printed its ready line.
 * @param {{key:string,name:string,executablePath:string,bundleId?:string,color?:string}} app
 * @param {{x:number,y:number,width?:number,height?:number,onLine?:(line:string)=>void}} placement
 */
export function launchFixtureApp(app, { x, y, width = 1280, height = 720, onLine } = {}) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(
      app.executablePath,
      ['--width', String(width), '--height', String(height), '--x', String(x), '--y', String(y)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const fixture = {
      key: app.key,
      name: app.name,
      bundleId: app.bundleId ?? null,
      color: app.color ?? null,
      appPath: app.appPath ?? null,
      pid: child.pid,
      child,
      windowNumber: null,
      windowId: null,
      lines: [],
      flashWaiters: [],
      exited: null
    }
    let buffer = ''
    const timer = setTimeout(
      () =>
        rejectLaunch(new Error(`${app.name} printed no ready line within ${READY_TIMEOUT_MS} ms`)),
      READY_TIMEOUT_MS
    )
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
        const ready = /^ready pid=(\d+) window_number=(\d+)/.exec(line)
        if (ready) {
          clearTimeout(timer)
          fixture.windowNumber = Number(ready[2])
          fixture.windowId = `window:screencapturekit:${ready[2]}`
          resolveLaunch(fixture)
        }
        const drawn = /^flash drawn_at_ms=(\d+)/.exec(line)
        if (drawn) {
          const waiter = fixture.flashWaiters.shift()
          waiter?.(Number(drawn[1]))
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) fixture.lines.push(`stderr: ${line}`)
    })
    child.on('exit', (code, signal) => {
      fixture.exited = { code, signal }
      clearTimeout(timer)
      rejectLaunch(
        new Error(`${app.name} exited before it was ready: code=${code} signal=${signal}`)
      )
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectLaunch(error)
    })
  })
}

/**
 * SIGUSR1 makes the fixture flash white for 200 ms and print when it drew it.
 * Resolves with the draw time (wall clock, ms); falls back to the send time
 * when the fixture never reports.
 */
export function flashFixtureApp(fixture, label) {
  return new Promise((resolveFlash) => {
    const sentAtMs = Date.now()
    const timer = setTimeout(() => {
      fixture.flashWaiters = fixture.flashWaiters.filter((entry) => entry !== onDrawn)
      resolveFlash({ label, sentAtMs, drawnAtMs: sentAtMs, drawnReported: false })
    }, FLASH_TIMEOUT_MS)
    const onDrawn = (drawnAtMs) => {
      clearTimeout(timer)
      resolveFlash({ label, sentAtMs, drawnAtMs, drawnReported: true })
    }
    fixture.flashWaiters.push(onDrawn)
    try {
      process.kill(fixture.pid, 'SIGUSR1')
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

/** SIGTERM, then SIGKILL after `graceMs`, for one fixture. Resolves when it is gone. */
export async function stopFixtureApp(fixture, { graceMs = 2000 } = {}) {
  if (!fixture || fixture.exited || !fixture.pid) return
  try {
    process.kill(fixture.pid, 'SIGTERM')
  } catch {
    return
  }
  const exited = await Promise.race([
    new Promise((resolveExit) => fixture.child.once('exit', () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), graceMs))
  ])
  if (!exited) {
    try {
      process.kill(fixture.pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
}

export async function stopFixtureApps(fixtures, options) {
  for (const fixture of fixtures) await stopFixtureApp(fixture, options)
}

/**
 * Brings a running fixture to the front through LaunchServices. The bundle
 * path, not the bundle id: these bundles live in a temp directory LS has not
 * indexed. Resolves when `open` returns; use `waitForFrontApp` for the moment
 * the OS made it front.
 */
export function activateApp(appPath) {
  return new Promise((resolveOpen, rejectOpen) => {
    execFile('open', [appPath], (error, _stdout, stderr) => {
      if (error) rejectOpen(new Error(`open ${appPath} failed: ${stderr || error.message}`))
      else resolveOpen()
    })
  })
}

/** The front app's bundle id and pid as LaunchServices sees it, or null. */
export function frontApp() {
  return new Promise((resolveFront) => {
    execFile('lsappinfo', ['front'], (error, asn) => {
      const trimmed = String(asn ?? '').trim()
      if (error || !trimmed) return resolveFront(null)
      execFile(
        'lsappinfo',
        ['info', '-only', 'bundleid', '-only', 'pid', trimmed],
        (infoError, out) => {
          if (infoError) return resolveFront(null)
          const bundleId = /"CFBundleIdentifier"="([^"]*)"/.exec(out)?.[1] ?? null
          const pid = Number(/"pid"=(\d+)/.exec(out)?.[1] ?? NaN)
          resolveFront({ bundleId, pid: Number.isFinite(pid) ? pid : null, asn: trimmed })
        }
      )
    })
  })
}

/**
 * Polls `frontApp` until `predicate` holds; resolves with the wall time of the
 * poll that first saw it (the observation of the activation, within `pollMs`).
 */
export async function waitForFrontApp(predicate, { timeoutMs = 4000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await frontApp()
    const seenAtMs = Date.now()
    if (last && predicate(last)) return { ...last, seenAtMs }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs))
  }
  throw new Error(`front app never matched within ${timeoutMs} ms; last ${JSON.stringify(last)}`)
}
