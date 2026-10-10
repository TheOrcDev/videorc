// Undo instead of a question (plan 174 S0.3, E-8): a frequent, cheap-to-restore
// action runs after a short window unless it is undone first. Pure: the
// timers are injected so tests drive the clock.

export interface UndoableAction {
  /** Cancels the action if it has not run yet; a no-op afterwards. */
  undo: () => void
  /** Runs the action now if it is still pending (an owner going away). */
  flush: () => void
  /** `pending` until it runs, is undone or flushed. */
  readonly state: 'pending' | 'done' | 'undone'
}

type Timers = {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** Schedules `run` after `windowMs`, unless `undo` comes first. */
export function scheduleUndoableAction(
  run: () => void,
  windowMs: number,
  timers: Timers = defaultTimers
): UndoableAction {
  let state: UndoableAction['state'] = 'pending'
  const fire = (): void => {
    if (state !== 'pending') return
    state = 'done'
    run()
  }
  const handle = timers.setTimeout(fire, windowMs)
  return {
    undo: () => {
      if (state !== 'pending') return
      state = 'undone'
      timers.clearTimeout(handle)
    },
    flush: () => {
      if (state !== 'pending') return
      timers.clearTimeout(handle)
      fire()
    },
    get state() {
      return state
    }
  }
}
