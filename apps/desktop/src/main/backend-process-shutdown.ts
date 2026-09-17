import type { ChildProcessWithoutNullStreams } from 'node:child_process'

export type BackendShutdownResult = 'skipped' | 'closed' | 'already-exited' | 'timed-out'
export type BackendQuitAction = 'allow' | 'prevent-and-start' | 'prevent-and-wait'
export type BackendShutdownTarget = 'absent' | 'exact' | 'inconsistent'
export type BackendShutdownReceiptExpectation = { requestId: string; backendPid: number }
export type BackendShutdownSignal = 'SIGTERM' | 'SIGINT'

export type BackendShutdownSignalSource = {
  on(signal: BackendShutdownSignal, listener: () => void): unknown
}
export type BackendQuitState = { complete: boolean; inProgress: boolean }
export type BackendBeforeQuitEvent = { preventDefault(): void }

export type BackendQuitCoordinatorOptions = {
  stopBackend: () => Promise<unknown>
  quit: () => void
  onFailure: (error: unknown) => void
}

export function installPersistentBackendShutdownSignalHandlers(
  source: BackendShutdownSignalSource,
  requestQuit: (signal: BackendShutdownSignal) => void
): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    source.on(signal, () => requestQuit(signal))
  }
}

export function classifyBackendShutdownTarget<TProcess extends object>(
  child: TProcess | null,
  runtime: { process: TProcess } | null
): BackendShutdownTarget {
  if (!child && !runtime) {
    return 'absent'
  }
  if (!child || !runtime || runtime.process !== child) {
    return 'inconsistent'
  }
  return 'exact'
}

export function backendQuitAction(complete: boolean, inProgress: boolean): BackendQuitAction {
  if (complete) {
    return 'allow'
  }
  return inProgress ? 'prevent-and-wait' : 'prevent-and-start'
}

export function handleBackendBeforeQuit(
  event: BackendBeforeQuitEvent,
  state: BackendQuitState,
  options: BackendQuitCoordinatorOptions
): BackendQuitAction {
  const action = backendQuitAction(state.complete, state.inProgress)
  if (action === 'allow') {
    return action
  }

  event.preventDefault()
  if (action === 'prevent-and-wait') {
    return action
  }

  state.inProgress = true
  void options
    .stopBackend()
    .then(() => {
      state.complete = true
      state.inProgress = false
      options.quit()
    })
    .catch((error: unknown) => {
      state.inProgress = false
      options.onFailure(error)
    })
  return action
}

export type BackendShutdownOptions = {
  shutdownReceipt?: unknown
  expectedShutdownReceipt?: BackendShutdownReceiptExpectation
  killGraceMs?: number
  timeoutMs?: number
}

export type PreBootstrapBackendShutdownOptions = {
  killGraceMs?: number
  timeoutMs?: number
}

export function backendShutdownAllowsForceKill(
  value: unknown,
  expected: BackendShutdownReceiptExpectation
): boolean {
  if (!value || typeof value !== 'object') {
    return false
  }
  const preparation = value as {
    shutdownLatched?: unknown
    captureFinalizationComplete?: unknown
    requestId?: unknown
    backendPid?: unknown
  }
  return (
    preparation.shutdownLatched === true &&
    preparation.captureFinalizationComplete === true &&
    preparation.requestId === expected.requestId &&
    preparation.backendPid === expected.backendPid
  )
}

// SIGKILL is armed only after the backend atomically latched shutdown and
// acknowledged that every accepted recording reached terminal publication.
// These bounds apply to the remaining device/process teardown, never to MKV
// flush, MP4 publication, or recording metadata persistence.
export const BACKEND_SHUTDOWN_KILL_GRACE_MS = 30_000
export const BACKEND_SHUTDOWN_TIMEOUT_MS = 35_000

// Before READY, the renderer has no backend authority and cannot have started
// a recording. Keep this separate from the receipt-protected shutdown below:
// once bootstrap authority exists, no bounded signal is allowed until capture
// finalization is acknowledged by the exact backend generation.
export const BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS = 5_000
export const BACKEND_PRE_BOOTSTRAP_SHUTDOWN_TIMEOUT_MS = 10_000

function backendBootstrapOutputIsDrained(child: ChildProcessWithoutNullStreams): boolean {
  return [child.stdout, child.stderr].every((stream) => stream.readableEnded || stream.destroyed)
}

/**
 * A shutdown timeout escalates signaling but is not bootstrap-channel closure.
 * Cargo can exit while its real child still owns stdout; keep the generation
 * alive until `close` or both inherited output streams prove drained so a late
 * authenticated ownership marker cannot be discarded.
 */
export async function waitForBackendBootstrapOutputDrain(
  child: ChildProcessWithoutNullStreams
): Promise<void> {
  if (backendBootstrapOutputIsDrained(child)) {
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      child.off('close', onChildClose)
      child.stdout.off('end', onOutputProgress)
      child.stdout.off('close', onOutputProgress)
      child.stderr.off('end', onOutputProgress)
      child.stderr.off('close', onOutputProgress)
      resolve()
    }
    const onChildClose = (): void => finish()
    const onOutputProgress = (): void => {
      if (backendBootstrapOutputIsDrained(child)) finish()
    }
    child.once('close', onChildClose)
    child.stdout.on('end', onOutputProgress)
    child.stdout.on('close', onOutputProgress)
    child.stderr.on('end', onOutputProgress)
    child.stderr.on('close', onOutputProgress)
    onOutputProgress()
  })
}

export async function stopPreBootstrapBackendProcess(
  child: ChildProcessWithoutNullStreams | null,
  options: PreBootstrapBackendShutdownOptions = {}
): Promise<BackendShutdownResult> {
  if (!child) {
    return 'skipped'
  }

  if (
    (child.exitCode !== null || child.signalCode !== null) &&
    backendBootstrapOutputIsDrained(child)
  ) {
    return 'already-exited'
  }

  const killGraceMs = options.killGraceMs ?? BACKEND_PRE_BOOTSTRAP_SHUTDOWN_KILL_GRACE_MS
  const timeoutMs = options.timeoutMs ?? BACKEND_PRE_BOOTSTRAP_SHUTDOWN_TIMEOUT_MS

  return await new Promise<BackendShutdownResult>((resolve) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: BackendShutdownResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      child.off('close', onClose)
      resolve(result)
    }

    const processAlreadyExited = (error: unknown): boolean => {
      const errorCode =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined
      return errorCode === 'ESRCH' || child.exitCode !== null || child.signalCode !== null
    }
    const signal = (value: NodeJS.Signals): void => {
      try {
        child.kill(value)
      } catch (error) {
        if (processAlreadyExited(error) && backendBootstrapOutputIsDrained(child)) {
          finish('already-exited')
        }
      }
    }

    const onClose = (): void => finish('closed')

    child.once('close', onClose)

    killTimer = setTimeout(() => signal('SIGKILL'), killGraceMs)
    timeoutTimer = setTimeout(() => finish('timed-out'), timeoutMs)
    signal('SIGTERM')
  })
}

export async function stopBackendProcess(
  child: ChildProcessWithoutNullStreams | null,
  options: BackendShutdownOptions = {}
): Promise<BackendShutdownResult> {
  if (!child) {
    return 'skipped'
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return 'already-exited'
  }

  const forceKillAllowed = options.expectedShutdownReceipt
    ? backendShutdownAllowsForceKill(options.shutdownReceipt, options.expectedShutdownReceipt)
    : false
  const killGraceMs = options.killGraceMs ?? BACKEND_SHUTDOWN_KILL_GRACE_MS
  const timeoutMs = options.timeoutMs ?? BACKEND_SHUTDOWN_TIMEOUT_MS

  return await new Promise<BackendShutdownResult>((resolve) => {
    let settled = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: BackendShutdownResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (killTimer) {
        clearTimeout(killTimer)
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer)
      }
      child.off('close', onClose)
      child.off('exit', onExit)
      resolve(result)
    }

    const onClose = (): void => finish('closed')
    const onExit = (): void => finish('closed')

    child.once('close', onClose)
    child.once('exit', onExit)

    if (forceKillAllowed) {
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          finish('already-exited')
        }
      }, killGraceMs)

      timeoutTimer = setTimeout(() => finish('timed-out'), timeoutMs)
    }
  })
}
