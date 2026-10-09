import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode
} from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  AiCapabilities,
  CohostAvatarCreateParams,
  CohostAvatarDraft,
  CohostAvatarDraftStatus,
  CohostAvatarPhase,
  CohostAvatarRedoState,
  CohostAvatarRunning,
  CohostAvatarState,
  CohostSettings
} from '@/lib/backend'

/** The calls the look panel makes; the app's `BackendClient`, a fake in tests. */
export type BuddyLookClient = Pick<BackendClient, 'requestTyped' | 'request' | 'on'>

export interface BuddyLookProblem {
  code: string
  message: string
}

export type BuddyLookPending = 'create' | 'redo' | 'keep' | 'discard'

export interface BuddyLookState {
  /** The first status has not arrived yet. */
  loading: boolean
  /** The active Golem's draft (made earlier and still on disk, or just now). */
  draft: CohostAvatarDraft | null
  /** The job running in the backend (this window's, or one picked up). */
  running: CohostAvatarRunning | null
  /** Each state's step in the running job, from `cohost.avatar.progress`. */
  phases: Partial<Record<CohostAvatarState, CohostAvatarPhase>>
  /** Why the last attempt at a state failed (a failed redo keeps its picture). */
  stateErrors: Partial<Record<CohostAvatarState, string>>
  /** A call this window is waiting on (the accept, keep or discard). */
  pending: BuddyLookPending | null
  /** The last refusal, or a create that made nothing. */
  problem: BuddyLookProblem | null
  /** Bumped when a draft picture was made again under the same path. */
  revision: number
  /** Today's images as the web last reported them (fresh after each job). */
  capabilities: AiCapabilities | null
}

const INITIAL: BuddyLookState = {
  loading: true,
  draft: null,
  running: null,
  phases: {},
  stateErrors: {},
  pending: null,
  problem: null,
  revision: 0,
  capabilities: null
}

/** The accept calls answer at once; the web work rides events. */
const ACCEPT_TIMEOUT_MS = 15_000
const KEEP_TIMEOUT_MS = 35_000
/** The backend waits 190 s for the web; past this the panel asks again. */
const RUN_WATCHDOG_MS = 200_000

function problemOf(error: unknown): BuddyLookProblem {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'failed'
  return {
    code,
    message: error instanceof Error ? error.message : 'Something went wrong. Try again.'
  }
}

export interface BuddyLookController {
  getState: () => BuddyLookState
  subscribe: (listener: () => void) => () => void
  refresh: () => Promise<void>
  /** Make a new set (Create my Golem): the look, and the library avatar's
   * name, personality and "About you" (plan 170 D13). Empty fields are left out. */
  create: (input: CohostAvatarCreateParams) => Promise<void>
  /** Make one state of the draft again from its idle. */
  redo: (state: CohostAvatarRedoState) => Promise<void>
  /** The draft becomes the look; the saved settings, or null when refused. */
  keep: () => Promise<CohostSettings | null>
  discard: () => Promise<void>
  dispose: () => void
}

/**
 * The look's state over the backend (plan 169 D9): `cohost.avatar.draft.get`,
 * the accept calls and their events. The backend keeps the draft on disk, so
 * a fresh controller (a remount, a restart) picks it up where it was.
 */
export function createBuddyLookController(client: BuddyLookClient): BuddyLookController {
  let state = INITIAL
  let disposed = false
  let watchdog: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const set = (patch: Partial<BuddyLookState>): void => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const clearWatchdog = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }
  const armWatchdog = (): void => {
    clearWatchdog()
    watchdog = setTimeout(() => void refresh(), RUN_WATCHDOG_MS)
  }

  const refreshCapabilities = async (): Promise<void> => {
    try {
      const capabilities = await client.request<AiCapabilities>('ai.capabilities.get')
      set({ capabilities })
    } catch {
      // The studio's own copy stays the fallback.
    }
  }

  const refresh = async (): Promise<void> => {
    try {
      const status: CohostAvatarDraftStatus = await client.requestTyped(
        'cohost.avatar.draft.get',
        undefined,
        { timeoutMs: ACCEPT_TIMEOUT_MS }
      )
      const running = status.running ?? null
      const wasRunning = state.running !== null
      set({
        loading: false,
        draft: status.draft ?? null,
        running,
        ...(running
          ? {
              phases:
                wasRunning && state.running?.requestId === running.requestId
                  ? state.phases
                  : running.kind === 'create'
                    ? { idle: 'working' as const }
                    : running.state
                      ? { [running.state]: 'working' as const }
                      : {}
            }
          : { phases: {} })
      })
      if (running) armWatchdog()
      else clearWatchdog()
    } catch (error) {
      set({ loading: false, problem: problemOf(error) })
    }
  }

  /** A job ended: the slot is free, and today's images changed. */
  const ended = (patch: Partial<BuddyLookState>): void => {
    clearWatchdog()
    set({ running: null, pending: null, phases: {}, ...patch })
    void refreshCapabilities()
  }

  const offs = [
    client.on('cohost.avatar.progress', (event) => {
      // One job runs at a time per process: a progress while this window
      // waits on its create's accept is that create's.
      if (!state.running && state.pending === 'create' && event.state === 'idle') {
        set({ running: { requestId: event.requestId, kind: 'create' } })
      }
      if (event.requestId !== state.running?.requestId) return
      const stateErrors = { ...state.stateErrors }
      if (event.phase === 'failed' && event.error) stateErrors[event.state] = event.error.message
      if (event.phase !== 'failed') delete stateErrors[event.state]
      set({ phases: { ...state.phases, [event.state]: event.phase }, stateErrors })
      const running = state.running
      // A create that failed its idle made nothing; it ends here. A redo
      // ends with the draft event, unless its draft was discarded meanwhile.
      if (running?.kind === 'create' && event.state === 'idle' && event.phase === 'failed') {
        ended({
          problem: event.error ?? { code: 'failed', message: 'The look could not be made.' }
        })
      } else if (running?.kind === 'redo' && event.error?.code === 'cohost-avatar-cancelled') {
        ended({})
      }
    }),
    client.on('cohost.avatar.draft', (event) => {
      const running = state.running
      const ours =
        running?.requestId === event.requestId || state.draft?.requestId === event.requestId
      if (!ours) return
      const redone = running?.kind === 'redo'
      // A fresh set clears the last run's per-state lines; a redo keeps the others.
      const stateErrors = redone ? state.stateErrors : { ...failedLines(event) }
      ended({
        draft: event,
        stateErrors,
        problem: null,
        revision: redone ? state.revision + 1 : state.revision
      })
    })
  ]

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: async () => {
      await refresh()
      await refreshCapabilities()
    },
    create: async ({ description, inspirationBase64, name, personality, context }) => {
      if (state.pending || state.running) return
      set({ pending: 'create', problem: null, stateErrors: {}, phases: { idle: 'working' } })
      try {
        const accepted = await client.requestTyped(
          'cohost.avatar.create',
          {
            ...(description ? { description } : {}),
            ...(inspirationBase64 ? { inspirationBase64 } : {}),
            ...(name ? { name } : {}),
            ...(personality ? { personality } : {}),
            ...(context ? { context } : {})
          },
          { timeoutMs: ACCEPT_TIMEOUT_MS }
        )
        // The run may already have ended (a fast failure) by the time the
        // accept lands; only a run still open is adopted.
        if (state.pending === 'create') {
          set({ pending: null, running: { requestId: accepted.requestId, kind: 'create' } })
          armWatchdog()
        }
      } catch (error) {
        set({ pending: null, phases: {}, problem: problemOf(error) })
      }
    },
    redo: async (avatarState) => {
      const draft = state.draft
      if (!draft || state.pending || state.running) return
      const stateErrors = { ...state.stateErrors }
      delete stateErrors[avatarState]
      set({
        pending: 'redo',
        problem: null,
        stateErrors,
        running: { requestId: draft.requestId, kind: 'redo', state: avatarState },
        phases: { [avatarState]: 'working' }
      })
      try {
        await client.requestTyped(
          'cohost.avatar.redo',
          { requestId: draft.requestId, state: avatarState },
          { timeoutMs: ACCEPT_TIMEOUT_MS }
        )
        if (state.pending === 'redo') set({ pending: null })
        if (state.running) armWatchdog()
      } catch (error) {
        set({ pending: null, running: null, phases: {}, problem: problemOf(error) })
      }
    },
    keep: async () => {
      const draft = state.draft
      if (!draft || state.pending || state.running) return null
      set({ pending: 'keep', problem: null })
      try {
        const settings = await client.requestTyped(
          'cohost.avatar.keep',
          { requestId: draft.requestId },
          { timeoutMs: KEEP_TIMEOUT_MS }
        )
        set({ pending: null, draft: null, stateErrors: {}, revision: 0 })
        return settings
      } catch (error) {
        set({ pending: null, problem: problemOf(error) })
        return null
      }
    },
    discard: async () => {
      const draft = state.draft
      if (!draft || state.pending || state.running) return
      set({ pending: 'discard', problem: null })
      try {
        const status = await client.requestTyped(
          'cohost.avatar.discard',
          { requestId: draft.requestId },
          { timeoutMs: ACCEPT_TIMEOUT_MS }
        )
        set({
          pending: null,
          draft: status.draft ?? null,
          stateErrors: {},
          revision: 0
        })
      } catch (error) {
        set({ pending: null, problem: problemOf(error) })
      }
    },
    dispose: () => {
      disposed = true
      clearWatchdog()
      for (const off of offs) off()
      listeners.clear()
    }
  }
}

function failedLines(draft: CohostAvatarDraft): Partial<Record<CohostAvatarState, string>> {
  const lines: Partial<Record<CohostAvatarState, string>> = {}
  for (const [avatarState, failure] of Object.entries(draft.failed) as [
    CohostAvatarState,
    { message: string }
  ][]) {
    lines[avatarState] = failure.message
  }
  return lines
}

/** The client the Golem tab shares (plan 170): undefined outside a provider. */
const BuddyLookClientContext = createContext<BackendClient | null | undefined>(undefined)

/** A backend client of its own while `enabled` and connected; null otherwise. */
function useOwnBuddyLookClient(enabled: boolean): BackendClient | null {
  const { connection, wsStatus } = useStudioCore()
  const online = enabled && wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    next.connect().then(
      () => {
        if (!disposed) setClient(next)
      },
      () => undefined
    )
    return () => {
      disposed = true
      next.close()
      setClient(null)
    }
  }, [online])
  return client
}

/**
 * One client for every Golem surface under it (the Golem tab: My Golems,
 * the look panel and the onboarding sheet), so they share one connection
 * and, through `useBuddyLook`, one look controller: a Golem created in the
 * sheet shows as working and then as a draft in the look panel too.
 */
export function BuddyLookClientProvider({ children }: { children: ReactNode }): ReactElement {
  const client = useOwnBuddyLookClient(true)
  return createElement(BuddyLookClientContext.Provider, { value: client }, children)
}

/**
 * The look panel's backend client: the provider's when there is one, else
 * its own while mounted (like the pet creator), so the shell carries nothing
 * for it. Null until it is connected.
 */
export function useBuddyLookClient(): BackendClient | null {
  const provided = useContext(BuddyLookClientContext)
  const own = useOwnBuddyLookClient(provided === undefined)
  return provided === undefined ? own : provided
}

/** One controller per client, counted by its users, so every surface on the
 * same client sees the same draft, job and problem. */
const sharedControllers = new WeakMap<
  BuddyLookClient,
  { controller: BuddyLookController; users: number }
>()

function acquireBuddyLookController(client: BuddyLookClient): BuddyLookController {
  const shared = sharedControllers.get(client)
  if (shared) {
    shared.users += 1
    return shared.controller
  }
  const controller = createBuddyLookController(client)
  sharedControllers.set(client, { controller, users: 1 })
  return controller
}

function releaseBuddyLookController(client: BuddyLookClient): void {
  const shared = sharedControllers.get(client)
  if (!shared) return
  shared.users -= 1
  if (shared.users > 0) return
  sharedControllers.delete(client)
  shared.controller.dispose()
}

/** The client's (shared) controller, its state as React state. */
export function useBuddyLook(client: BuddyLookClient | null): {
  state: BuddyLookState
  controller: BuddyLookController | null
} {
  // A surface that mounts beside another on the same client (the onboarding
  // over the look panel) starts from the shared state, not from loading.
  const [controller, setController] = useState<BuddyLookController | null>(() =>
    client ? (sharedControllers.get(client)?.controller ?? null) : null
  )
  useEffect(() => {
    if (!client) return
    const next = acquireBuddyLookController(client)
    setController(next)
    void next.refresh()
    return () => {
      releaseBuddyLookController(client)
      setController(null)
    }
  }, [client])
  const state = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? initialState,
    controller?.getState ?? initialState
  )
  return { state, controller }
}

const noopSubscribe = (): (() => void) => () => undefined
const initialState = (): BuddyLookState => INITIAL
