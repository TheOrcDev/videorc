// Keeps the Windows display awake for a smoke's lifetime (issue #1088).
// Windows refuses Desktop Duplication to every process while the display is
// off (E_ACCESSDENIED, 0x80070005), and Windows Graphics Capture slows to a
// few frames a second, so a smoke that waits out a long backend build past
// the display timeout measures a sleeping display, not Videorc. The request
// is ES_CONTINUOUS | ES_DISPLAY_REQUIRED held by one PowerShell child until
// its stdin closes; it keeps an awake display on but cannot wake one that is
// already off. Nothing persists: the request ends with the child.

import { spawn, spawnSync } from 'node:child_process'

export const DISPLAY_AWAKE_SCRIPT = [
  'Add-Type -Namespace VideorcSmoke -Name Power -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);\'',
  // ES_CONTINUOUS | ES_DISPLAY_REQUIRED, held on this thread.
  "[void][VideorcSmoke.Power]::SetThreadExecutionState([Convert]::ToUInt32('80000002', 16))",
  "[Console]::Out.WriteLine('display-awake held')",
  '[void][Console]::In.ReadToEnd()',
  "[void][VideorcSmoke.Power]::SetThreadExecutionState([Convert]::ToUInt32('80000000', 16))"
].join('; ')

/**
 * Holds the display awake until `release()`. Resolves once the request is
 * held; on any failure resolves `{held: false, reason}` so the smoke reports
 * it instead of failing.
 * @returns {Promise<{held:boolean, reason?:string, pid?:number, release:()=>void}>}
 */
export function holdWindowsDisplayAwake({ timeoutMs = 10_000 } = {}) {
  if (process.platform !== 'win32')
    return Promise.resolve({ held: false, reason: 'not Windows', release: () => {} })
  return new Promise((resolveHold) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', DISPLAY_AWAKE_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    )
    let settled = false
    const release = () => {
      try {
        child.stdin.end()
      } catch {
        // already closed
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      }, 2000).unref()
    }
    const settle = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveHold(value)
    }
    const timer = setTimeout(() => {
      release()
      settle({ held: false, reason: `no answer within ${timeoutMs} ms`, release: () => {} })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      if (text.includes('display-awake held')) settle({ held: true, pid: child.pid, release })
    })
    child.once('error', (error) =>
      settle({ held: false, reason: String(error?.message ?? error), release: () => {} })
    )
    child.once('exit', (code) =>
      settle({ held: false, reason: `PowerShell exited with ${code}`, release: () => {} })
    )
  })
}
