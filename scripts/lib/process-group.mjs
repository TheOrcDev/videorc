import { spawn } from 'node:child_process'

/** Own a POSIX process group for the entire timeout/interrupt cleanup. */
export function spawnProcessGroup(
  command,
  args,
  { timeoutMs, graceMs = 2000, onTimeout, onInterrupt, ...options } = {}
) {
  const grouped = process.platform !== 'win32'
  const child = spawn(command, args, { ...options, detached: grouped })
  let timedOut = false
  let interrupted = false
  let error
  let escalation
  let timer
  const signal = (name) => {
    if (!child.pid) return
    try {
      if (grouped) process.kill(-child.pid, name)
      else child.kill(name)
    } catch (error) {
      if (error.code === 'ESRCH') return
      // Darwin reports EPERM for process groups containing only unreaped zombies.
      if (grouped && process.platform === 'darwin' && error.code === 'EPERM') return
      throw error
    }
  }
  const stop = (name) => {
    clearTimeout(timer)
    signal(name)
    // Do not cancel escalation when only the group leader exits: its children
    // may still be alive, including children that ignored SIGTERM.
    escalation ??= new Promise((resolve) => {
      setTimeout(() => {
        try {
          signal('SIGKILL')
        } catch (failure) {
          error = failure
        }
        resolve()
      }, graceMs)
    })
  }
  const interrupt = (name) => {
    interrupted = true
    onInterrupt?.(name)
    stop(name)
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)
  const cleanup = () => {
    clearTimeout(timer)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
  child.once('exit', cleanup)
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      onTimeout?.()
      stop('SIGTERM')
    }, timeoutMs)
  }
  const result = new Promise((resolve) => {
    child.once('error', (failure) => {
      error = failure
      cleanup()
    })
    child.once('close', async (status, signal) => {
      cleanup()
      await escalation
      resolve({ status, signal, error, timedOut, interrupted })
    })
  })
  return { child, result }
}
