import { useEffect, useState, useSyncExternalStore } from 'react'

import type { BackendClient } from '@/backendClient'
import type {
  CohostLibraryUpdateParams,
  GolemLibraryId,
  GolemLibraryState,
  GolemLibrarySyncReason
} from '@/lib/backend'

/** The calls the library makes; the app's `BackendClient`, a fake in tests. */
export type GolemLibraryClient = Pick<BackendClient, 'requestTyped' | 'on'>

export interface GolemLibraryProblem {
  code: string
  message: string
}

export type GolemLibraryPending = 'sync' | 'use' | 'update' | 'delete'

export interface GolemLibraryViewState {
  /** The first `cohost.library.get` has not answered yet. */
  loading: boolean
  /** The backend's library (official + mine, the active one, its own `busy`
   * and last `error`); null until loaded. */
  library: GolemLibraryState | null
  /** An accept call this window is waiting on. The work itself shows as
   * `library.busy` and ends with `cohost.library.changed`. */
  pending: GolemLibraryPending | null
  /** The last refused call (bad id, not signed in, not available yet). */
  problem: GolemLibraryProblem | null
}

const INITIAL: GolemLibraryViewState = {
  loading: true,
  library: null,
  pending: null,
  problem: null
}

/** Every library call answers at once (the 10 s mutation lane); the web work rides the event. */
const ACCEPT_TIMEOUT_MS = 15_000

function problemOf(error: unknown): GolemLibraryProblem {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'failed'
  return {
    code,
    message: error instanceof Error ? error.message : 'Something went wrong. Try again.'
  }
}

export interface GolemLibraryController {
  getState: () => GolemLibraryViewState
  subscribe: (listener: () => void) => () => void
  /** `cohost.library.get`: the cached state, no network. */
  refresh: () => Promise<void>
  /** `cohost.library.sync`; true when the backend accepted it. */
  sync: (reason: GolemLibrarySyncReason) => Promise<boolean>
  /** `cohost.library.use`: make a library or official avatar the Golem. */
  use: (avatarId: GolemLibraryId) => Promise<boolean>
  /** `cohost.library.update`: rename or edit one of the account's own avatars. */
  update: (params: CohostLibraryUpdateParams) => Promise<boolean>
  /** `cohost.library.delete`: one of the account's own avatars. */
  remove: (avatarId: string) => Promise<boolean>
  dispose: () => void
}

/**
 * The Golem library over the backend (plan 170 D12, D13): `cohost.library.get`,
 * the accept calls and `cohost.library.changed`, which always carries the
 * whole state. The backend owns the library and its cache, so a fresh
 * controller (a remount, a restart) shows it where it was.
 */
export function createGolemLibraryController(client: GolemLibraryClient): GolemLibraryController {
  let state = INITIAL
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<GolemLibraryViewState>): void => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  const refresh = async (): Promise<void> => {
    try {
      const library = await client.requestTyped('cohost.library.get', undefined, {
        timeoutMs: ACCEPT_TIMEOUT_MS
      })
      set({ loading: false, library })
    } catch (error) {
      set({ loading: false, problem: problemOf(error) })
    }
  }

  /** One accept call at a time from this window; the event brings the outcome. */
  const accept = async (pending: GolemLibraryPending, call: () => Promise<unknown>) => {
    if (state.pending) return false
    set({ pending, problem: null })
    try {
      await call()
      set({ pending: null })
      return true
    } catch (error) {
      set({ pending: null, problem: problemOf(error) })
      return false
    }
  }

  const off = client.on('cohost.library.changed', (library) => {
    set({ loading: false, library })
  })

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    sync: (reason) =>
      accept('sync', () =>
        client.requestTyped('cohost.library.sync', { reason }, { timeoutMs: ACCEPT_TIMEOUT_MS })
      ),
    use: (avatarId) =>
      accept('use', () =>
        client.requestTyped('cohost.library.use', { avatarId }, { timeoutMs: ACCEPT_TIMEOUT_MS })
      ),
    update: (params) =>
      accept('update', () =>
        client.requestTyped('cohost.library.update', params, { timeoutMs: ACCEPT_TIMEOUT_MS })
      ),
    remove: (avatarId) =>
      accept('delete', () =>
        client.requestTyped('cohost.library.delete', { avatarId }, { timeoutMs: ACCEPT_TIMEOUT_MS })
      ),
    dispose: () => {
      disposed = true
      off()
      listeners.clear()
    }
  }
}

/**
 * One controller per client, its state as React state. Pass the panel's own
 * client (`useGolemLookClient()` from `use-golem-look`), or null while the
 * backend is not connected. Mounting it syncs the library (`reason: 'tab'`),
 * so callers do not sync on mount themselves.
 */
export function useGolemLibrary(client: GolemLibraryClient | null): {
  state: GolemLibraryViewState
  controller: GolemLibraryController | null
} {
  const [controller, setController] = useState<GolemLibraryController | null>(null)
  useEffect(() => {
    if (!client) return
    const next = createGolemLibraryController(client)
    setController(next)
    // D12: opening the Golem tab (where the library mounts) syncs it; the
    // backend coalesces a sync already queued.
    void next.refresh().then(() => next.sync('tab'))
    return () => {
      next.dispose()
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
const initialState = (): GolemLibraryViewState => INITIAL
