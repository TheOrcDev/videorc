import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

const NOT_PRESENTED_CAUSE = 'the display is off, its workspace is not shown or the host is starved'

/** The frames painted in one second, from a `motion-window-rate N` line. */
export function parseMotionRateLine(line) {
  const match = /^motion-window-rate (\d+)$/.exec(String(line ?? '').trim())
  return match ? Number(match[1]) : null
}

/**
 * Was the motion window presented through [from, to] (epoch ms)? Each sample
 * `{ at, fps }` counts the frames painted in the second that ended at `at`;
 * every second that overlaps the span must reach `minFps`. A compositor that
 * does not present the window (a display that is off, a hidden workspace)
 * gives it no frame callbacks, so it paints a few frames and then none, and a
 * capture of it repeats one picture (ogre, 2026-11-07). A session lock over a
 * lit display does not stop them, so linux-session-lock.mjs checks for that.
 */
export function assessMotionPresentation(samples, { from, to, minFps }) {
  const seconds = (samples ?? []).filter((sample) => sample.at > from && sample.at - 1000 < to)
  const failures = []
  if (seconds.length === 0) {
    failures.push(`no motion window paint count overlaps the span (${samples?.length ?? 0} in all)`)
  } else {
    const low = seconds.filter((sample) => !(sample.fps >= minFps))
    if (low.length > 0) {
      failures.push(
        `motion window painted ${low.map((sample) => sample.fps).join(', ')} frames/s in ` +
          `${low.length} of ${seconds.length} seconds, under ${minFps}: ${NOT_PRESENTED_CAUSE}`
      )
    }
  }
  return { ok: failures.length === 0, failures, fps: seconds.map((sample) => sample.fps) }
}

/**
 * Opens the motion probe window (linux-motion-window.cjs) with the desktop
 * app's Electron and resolves once it has painted and then painted at least
 * `minFps` in one second, i.e. the compositor presents it. `samples` keeps
 * filling with `{ at, fps }` until `stop()`, which kills and reaps only that
 * child. Rejects (after reaping) if it is not ready, or not presented within
 * `presentTimeoutMs` of being ready.
 */
export async function startLinuxMotionWindow({
  timeoutMs = 20000,
  minFps = 15,
  presentTimeoutMs = 5000,
  log = () => {}
} = {}) {
  const electronPath = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json'))('electron')
  const child = spawn(electronPath, [join(import.meta.dirname, 'linux-motion-window.cjs')], {
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(timer)
    }
  }
  const samples = []
  try {
    await new Promise((resolveReady, rejectReady) => {
      let readyAt = null
      let presentTimer = null
      const finish = (error) => {
        clearTimeout(timer)
        clearTimeout(presentTimer)
        if (error) rejectReady(error)
        else resolveReady()
      }
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              readyAt === null
                ? `motion window not ready after ${timeoutMs}ms`
                : `motion window not presented after ${timeoutMs}ms`
            )
          ),
        timeoutMs
      )
      child.once('exit', (code, signal) =>
        finish(new Error(`motion window exited early (code ${code}, signal ${signal})`))
      )
      let pending = ''
      child.stdout.on('data', (chunk) => {
        const lines = (pending + chunk.toString()).split('\n')
        pending = lines.pop()
        for (const line of lines) {
          if (line.trim()) log(line.trimEnd())
          const fps = parseMotionRateLine(line)
          if (fps !== null) {
            samples.push({ at: Date.now(), fps })
            if (readyAt !== null && fps >= minFps) finish()
          } else if (line.includes('motion-window-ready') && readyAt === null) {
            readyAt = Date.now()
            presentTimer = setTimeout(() => {
              const seen = samples.filter((sample) => sample.at >= readyAt)
              finish(
                new Error(
                  `motion window is not being presented (painted ` +
                    `${seen.map((sample) => sample.fps).join(', ') || 'no'} frames/s in ` +
                    `${presentTimeoutMs}ms, under ${minFps}): ${NOT_PRESENTED_CAUSE}`
                )
              )
            }, presentTimeoutMs)
          }
        }
      })
      child.stderr.on('data', (chunk) => log(chunk.toString().trimEnd()))
    })
  } catch (error) {
    await stop()
    throw error
  }
  return { pid: child.pid, samples, stop }
}
