export type BackendRuntimeState = 'active' | 'stopping' | 'shutdown-unconfirmed' | 'completed'

export interface OwnedBackendRuntime<TProcess extends object> {
  readonly generation: number
  readonly process: TProcess
  readonly ownedProcessPids: Set<number>
  state: BackendRuntimeState
}

export interface BackendRuntimeCompletion {
  readonly wasCurrent: boolean
  readonly wasIntentional: boolean
  readonly ownedProcessPids: readonly number[]
}

export interface ClassifiedOwnedProcessPids {
  readonly confirmedDead: readonly number[]
  readonly stillLive: readonly number[]
}

export interface BackendRuntimeExitSettlement extends ClassifiedOwnedProcessPids {
  readonly completed: boolean
  readonly wasCurrent: boolean
  readonly wasIntentional: boolean
}

export interface DurableBackendPidClaimOptions {
  /** Persist exact ownership evidence after in-memory ownership is established. */
  persist: () => void
  /** Terminate the spawned runtime when persistence cannot be guaranteed. */
  terminate: () => void
}

export interface BackendRuntimeTerminationOptions<TProcess extends object> {
  readonly runtimePid: number | undefined
  readonly signalExactPid: (pid: number) => boolean
  readonly signalRuntimeProcess: (process: TProcess) => boolean
}

/**
 * Keep ledger evidence unless identity-aware probing proves that the recorded
 * process is gone. The captured child pid is already proven dead by that
 * child's exit/close event; every additional runtime-owned pid must pass its
 * own exact ownership probe.
 */
export function classifyOwnedProcessPids(
  ownedProcessPids: readonly number[],
  confirmedExitedPid: number | undefined,
  processMayStillBeOwned: (pid: number) => boolean
): ClassifiedOwnedProcessPids {
  const confirmedDead: number[] = []
  const stillLive: number[] = []
  for (const pid of ownedProcessPids) {
    if (pid === confirmedExitedPid || !processMayStillBeOwned(pid)) {
      confirmedDead.push(pid)
    } else {
      stillLive.push(pid)
    }
  }
  return { confirmedDead, stillLive }
}

/**
 * Apply an exact process-exit observation without discarding unconfirmed
 * ownership. A runtime whose shutdown was already unconfirmed remains current
 * while any additional owned pid is still live or unprobeable.
 */
export function settleBackendRuntimeExit<TProcess extends object>(
  owner: BackendRuntimeOwner<TProcess>,
  runtime: OwnedBackendRuntime<TProcess>,
  confirmedExitedPid: number | undefined,
  processMayStillBeOwned: (pid: number) => boolean
): BackendRuntimeExitSettlement {
  if (runtime.state === 'completed') {
    return {
      completed: true,
      wasCurrent: false,
      wasIntentional: true,
      confirmedDead: [],
      stillLive: []
    }
  }

  const wasCurrent = owner.isCurrent(runtime)
  const wasIntentional = runtime.state !== 'active'
  const classified = classifyOwnedProcessPids(
    [...runtime.ownedProcessPids],
    confirmedExitedPid,
    processMayStillBeOwned
  )

  if (runtime.state === 'shutdown-unconfirmed' && classified.stillLive.length > 0) {
    for (const pid of classified.confirmedDead) {
      runtime.ownedProcessPids.delete(pid)
    }
    return { completed: false, wasCurrent, wasIntentional, ...classified }
  }

  owner.complete(runtime)
  return { completed: true, wasCurrent, wasIntentional, ...classified }
}

/**
 * Request hard termination without turning failed signals into success. Signal
 * acceptance is not process-death confirmation; callers must keep the runtime
 * unconfirmed until an exact exit/liveness observation settles ownership.
 */
export function requestBackendRuntimeTermination<TProcess extends object>(
  runtime: OwnedBackendRuntime<TProcess>,
  pid: number,
  options: BackendRuntimeTerminationOptions<TProcess>
): void {
  const failures: unknown[] = []

  if (pid !== options.runtimePid) {
    try {
      if (!options.signalExactPid(pid)) {
        failures.push(new Error(`Backend process ${pid} rejected SIGKILL.`))
      }
    } catch (error) {
      failures.push(error)
    }
  }

  try {
    if (!options.signalRuntimeProcess(runtime.process)) {
      failures.push(
        new Error(
          `Backend wrapper process ${options.runtimePid ?? 'with unknown pid'} rejected SIGKILL.`
        )
      )
    }
  } catch (error) {
    failures.push(error)
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Backend termination could not be confirmed as requested.')
  }
}

/** Owns exactly one backend runtime until its process death is confirmed. */
export class BackendRuntimeOwner<TProcess extends object> {
  private activeRuntime: OwnedBackendRuntime<TProcess> | null = null
  private nextGeneration = 0

  current(): OwnedBackendRuntime<TProcess> | null {
    return this.activeRuntime
  }

  start(process: TProcess): OwnedBackendRuntime<TProcess> {
    if (this.activeRuntime) {
      throw new Error('Cannot start a backend while the previous backend runtime is still owned.')
    }
    const runtime: OwnedBackendRuntime<TProcess> = {
      generation: ++this.nextGeneration,
      process,
      ownedProcessPids: new Set<number>(),
      state: 'active'
    }
    this.activeRuntime = runtime
    return runtime
  }

  isCurrent(runtime: OwnedBackendRuntime<TProcess>): boolean {
    return this.activeRuntime === runtime
  }

  recordOwnedPid(runtime: OwnedBackendRuntime<TProcess>, pid: number): void {
    if (runtime.state === 'completed') {
      return
    }
    runtime.ownedProcessPids.add(pid)
  }

  beginShutdown(runtime: OwnedBackendRuntime<TProcess>): void {
    if (this.isCurrent(runtime) && runtime.state === 'active') {
      runtime.state = 'stopping'
    }
  }

  markShutdownUnconfirmed(runtime: OwnedBackendRuntime<TProcess>): void {
    if (this.isCurrent(runtime) && runtime.state !== 'completed') {
      runtime.state = 'shutdown-unconfirmed'
    }
  }

  complete(runtime: OwnedBackendRuntime<TProcess>): BackendRuntimeCompletion {
    if (runtime.state === 'completed') {
      return { wasCurrent: false, wasIntentional: true, ownedProcessPids: [] }
    }
    const wasCurrent = this.isCurrent(runtime)
    const wasIntentional = runtime.state !== 'active'
    const ownedProcessPids = [...runtime.ownedProcessPids]
    runtime.ownedProcessPids.clear()
    runtime.state = 'completed'
    if (wasCurrent) {
      this.activeRuntime = null
    }
    return { wasCurrent, wasIntentional, ownedProcessPids }
  }
}

/**
 * Make durable ownership and runtime ownership one fail-closed transition.
 * A process that cannot be written to the exact-PID ledger must not continue
 * running, because an Electron crash would otherwise leave no reaping proof.
 */
export function claimDurableBackendPid<TProcess extends object>(
  owner: BackendRuntimeOwner<TProcess>,
  runtime: OwnedBackendRuntime<TProcess>,
  pid: number,
  options: DurableBackendPidClaimOptions
): void {
  // In-memory ownership begins before persistence. If persistence or
  // termination fails, this owner is the last fail-closed barrier preventing a
  // replacement runtime from starting while the exact pid may still be live.
  owner.recordOwnedPid(runtime, pid)
  try {
    options.persist()
  } catch (persistenceError) {
    owner.markShutdownUnconfirmed(runtime)
    try {
      options.terminate()
    } catch (terminationError) {
      throw new AggregateError(
        [persistenceError, terminationError],
        `Could not durably record backend process ${pid}, and terminating it also failed.`,
        { cause: terminationError }
      )
    }
    throw new Error(
      `Could not durably record backend process ${pid}; backend termination was requested.`,
      { cause: persistenceError }
    )
  }
}
