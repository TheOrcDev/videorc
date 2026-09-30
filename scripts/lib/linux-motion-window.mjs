import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')

/**
 * Opens the motion probe window (linux-motion-window.cjs) with the desktop
 * app's Electron and resolves once it has painted. `stop()` kills and reaps
 * only that child. Rejects (after reaping) if it is not ready in time.
 */
export async function startLinuxMotionWindow({ timeoutMs = 20000, log = () => {} } = {}) {
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
  try {
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(
        () => rejectReady(new Error(`motion window not ready after ${timeoutMs}ms`)),
        timeoutMs
      )
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        rejectReady(new Error(`motion window exited early (code ${code}, signal ${signal})`))
      })
      const onData = (chunk) => {
        const text = chunk.toString()
        log(text.trimEnd())
        if (text.includes('motion-window-ready')) {
          clearTimeout(timer)
          resolveReady()
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', (chunk) => log(chunk.toString().trimEnd()))
    })
  } catch (error) {
    await stop()
    throw error
  }
  return { pid: child.pid, stop }
}
