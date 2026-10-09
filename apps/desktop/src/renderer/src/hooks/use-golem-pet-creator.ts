import { useEffect, useState, useSyncExternalStore } from 'react'

import { BackendClient } from '@/backendClient'
import { useStudioCore } from '@/hooks/use-studio'
import type {
  AiCapabilities,
  CohostPetSaved,
  GolemPetBuildProgressEvent,
  GolemPetCreation,
  GolemPetCreationStatus,
  GolemPetIdentityNotes,
  GolemPetReference,
  GolemPetSheetKey
} from '@/lib/backend'
import { golemPetNextSheet } from '@/lib/golem-pet-creator-view'
import { GOLEM_PET_ATLAS_SHEETS } from '../../../shared/golem-pet-creator'

/** The calls the creator makes; the app's `BackendClient`, a fake in tests. */
export type GolemPetCreatorClient = Pick<BackendClient, 'requestTyped' | 'on'>

export interface GolemPetCreatorProblem {
  code: string
  message: string
}

export type GolemPetCreatorPending = 'start' | 'identity' | 'sheet' | 'build' | 'save' | 'cancel'

export interface GolemPetCreatorState {
  /** The first status has not arrived yet. */
  loading: boolean
  creation: GolemPetCreation | null
  /** A call this window started and is waiting on (the accept, or its event). */
  pending: GolemPetCreatorPending | null
  /** Keep making the missing sheets one at a time, then build. */
  autoSheets: boolean
  /** Why the last attempt at a sheet failed, until it is made. */
  sheetErrors: Partial<Record<GolemPetSheetKey, string>>
  /** Why reading the reference failed. */
  identityError: string | null
  /** The last refusal or failure outside a sheet (start, build, save ...). */
  problem: GolemPetCreatorProblem | null
  /** The running build's latest step. */
  build: GolemPetBuildProgressEvent | null
  /** The pack once saved. */
  saved: CohostPetSaved | null
}

const INITIAL: GolemPetCreatorState = {
  loading: true,
  creation: null,
  pending: null,
  autoSheets: false,
  sheetErrors: {},
  identityError: null,
  problem: null,
  build: null,
  saved: null
}

/** The accept calls answer at once; the long work rides events. */
const ACCEPT_TIMEOUT_MS = 15_000
const START_TIMEOUT_MS = 25_000
const SAVE_TIMEOUT_MS = 35_000

function problemOf(error: unknown): GolemPetCreatorProblem {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : 'failed'
  return {
    code,
    message: error instanceof Error ? error.message : 'Something went wrong. Try again.'
  }
}

export interface GolemPetCreatorController {
  getState: () => GolemPetCreatorState
  subscribe: (listener: () => void) => () => void
  refresh: () => Promise<void>
  /** Open a creation (when none is open) and read the reference. */
  readReference: (reference: GolemPetReference) => Promise<void>
  /** Make a pilot with the (corrected) notes. */
  makePilot: (notes: GolemPetIdentityNotes) => Promise<void>
  /** "Looks like my Golem": make the missing sheets, then build. */
  makeSheets: () => Promise<void>
  /** Redo one atlas sheet (counts against redos), then build again. */
  redoSheet: (key: GolemPetSheetKey) => Promise<void>
  build: () => Promise<void>
  save: (name: string) => Promise<CohostPetSaved | null>
  cancel: () => Promise<void>
  /** Cancel, then open a new creation with nothing in it. */
  startOver: () => Promise<void>
  dispose: () => void
}

/**
 * The creator's state over the backend (plan 168 S-F4): status, the accept
 * calls and their events. One job runs at a time; sheets are made one
 * after another, then the build runs. Everything persists in the backend,
 * so a fresh controller picks a creation up where it was.
 */
export function createGolemPetCreatorController(
  client: GolemPetCreatorClient
): GolemPetCreatorController {
  let state = INITIAL
  let autoBuild = false
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (patch: Partial<GolemPetCreatorState>): void => {
    if (disposed) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const buildId = (): string | null => state.creation?.buildId ?? null

  const refresh = async (): Promise<void> => {
    try {
      const status: GolemPetCreationStatus = await client.requestTyped(
        'cohost.pet.creation.status',
        undefined,
        { timeoutMs: ACCEPT_TIMEOUT_MS }
      )
      set({ loading: false, creation: status.creation })
    } catch (error) {
      set({ loading: false, problem: problemOf(error) })
    }
  }

  const generate = async (
    key: GolemPetSheetKey,
    redo: boolean,
    notes?: GolemPetIdentityNotes
  ): Promise<boolean> => {
    const id = buildId()
    if (!id) return false
    const sheet =
      key === 'pilot'
        ? { kind: 'pilot' as const }
        : GOLEM_PET_ATLAS_SHEETS.find((candidate) => candidate.key === key)
    if (!sheet) return false
    set({ pending: 'sheet', problem: null })
    try {
      await client.requestTyped(
        'cohost.pet.sheet.generate',
        {
          buildId: id,
          kind: sheet.kind,
          ...('row' in sheet && sheet.row ? { row: sheet.row } : {}),
          redo,
          ...(notes ? { notes } : {})
        },
        { timeoutMs: ACCEPT_TIMEOUT_MS }
      )
      await refresh()
      return true
    } catch (error) {
      const problem = problemOf(error)
      set({
        pending: null,
        autoSheets: false,
        sheetErrors: { ...state.sheetErrors, [key]: problem.message },
        problem
      })
      autoBuild = false
      return false
    }
  }

  const build = async (): Promise<void> => {
    const id = buildId()
    if (!id) return
    set({ pending: 'build', problem: null, build: null })
    try {
      await client.requestTyped(
        'cohost.pet.build',
        { buildId: id },
        { timeoutMs: ACCEPT_TIMEOUT_MS }
      )
      await refresh()
    } catch (error) {
      set({ pending: null, problem: problemOf(error) })
    }
  }

  /** The next missing sheet, or the build once every sheet is made. */
  const continueSheets = async (): Promise<void> => {
    const creation = state.creation
    if (!creation || !state.autoSheets) return
    const next = golemPetNextSheet(creation)
    if (next) {
      await generate(next.key, false)
      return
    }
    set({ autoSheets: false })
    if (!creation.build?.fresh) await build()
  }

  const offs = [
    client.on('cohost.pet.identity.read', (event) => {
      if (event.buildId !== buildId()) return
      set({ pending: null, identityError: event.error?.message ?? null })
      void refresh()
    }),
    client.on('cohost.pet.sheet.generated', (event) => {
      if (event.buildId !== buildId()) return
      const sheetErrors = { ...state.sheetErrors }
      if (event.error) {
        sheetErrors[event.sheet] = event.error.message
        autoBuild = false
        set({ pending: null, autoSheets: false, sheetErrors, problem: event.error })
        void refresh()
        return
      }
      delete sheetErrors[event.sheet]
      set({ pending: null, sheetErrors })
      void (async () => {
        await refresh()
        if (state.autoSheets) {
          await continueSheets()
        } else if (autoBuild) {
          autoBuild = false
          await build()
        }
      })()
    }),
    client.on('cohost.pet.build.progress', (event) => {
      if (event.buildId !== buildId()) return
      if (event.step === 'done' || event.step === 'failed') {
        set({
          pending: null,
          build: event,
          problem:
            event.step === 'failed'
              ? { code: event.code ?? 'failed', message: event.error ?? 'The build failed.' }
              : null
        })
        void refresh()
        return
      }
      set({ build: event })
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
    refresh,
    readReference: async (reference) => {
      set({ problem: null, identityError: null })
      if (!state.creation) {
        set({ pending: 'start' })
        try {
          const started: GolemPetCreationStatus = await client.requestTyped(
            'cohost.pet.creation.start',
            undefined,
            { timeoutMs: START_TIMEOUT_MS }
          )
          set({ creation: started.creation })
        } catch (error) {
          set({ pending: null, problem: problemOf(error) })
          return
        }
      }
      const id = buildId()
      if (!id) {
        set({ pending: null })
        return
      }
      set({ pending: 'identity' })
      try {
        await client.requestTyped(
          'cohost.pet.identity',
          { buildId: id, reference },
          { timeoutMs: ACCEPT_TIMEOUT_MS }
        )
      } catch (error) {
        set({ pending: null, problem: problemOf(error) })
      }
    },
    makePilot: async (notes) => {
      await generate('pilot', false, notes)
    },
    makeSheets: async () => {
      set({ autoSheets: true, sheetErrors: {} })
      await continueSheets()
    },
    redoSheet: async (key) => {
      autoBuild = true
      if (!(await generate(key, true))) autoBuild = false
    },
    build,
    save: async (name) => {
      const id = buildId()
      if (!id) return null
      set({ pending: 'save', problem: null })
      try {
        const saved = await client.requestTyped(
          'cohost.pet.save',
          { buildId: id, name },
          { timeoutMs: SAVE_TIMEOUT_MS }
        )
        set({ pending: null, saved, creation: null })
        return saved
      } catch (error) {
        set({ pending: null, problem: problemOf(error) })
        return null
      }
    },
    cancel: async () => {
      const id = buildId()
      if (!id) return
      set({ pending: 'cancel', problem: null, autoSheets: false })
      autoBuild = false
      try {
        const status: GolemPetCreationStatus = await client.requestTyped(
          'cohost.pet.creation.cancel',
          { buildId: id },
          { timeoutMs: ACCEPT_TIMEOUT_MS }
        )
        set({ ...INITIAL, loading: false, creation: status.creation })
      } catch (error) {
        set({ pending: null, problem: problemOf(error) })
      }
    },
    startOver: async () => {
      const id = buildId()
      if (id) {
        try {
          await client.requestTyped(
            'cohost.pet.creation.cancel',
            { buildId: id },
            { timeoutMs: ACCEPT_TIMEOUT_MS }
          )
        } catch (error) {
          set({ problem: problemOf(error) })
          return
        }
      }
      set({ ...INITIAL, loading: false })
    },
    dispose: () => {
      disposed = true
      for (const off of offs) off()
      listeners.clear()
    }
  }
}

/**
 * The creator for the wizard: its own backend client while mounted (like
 * the avatar generator), so the shell carries nothing for it. Null until the
 * client is connected. `capabilities` is fetched fresh on connect, so the
 * month's allowance is the server's latest.
 */
export function useGolemPetCreatorConnection(): {
  client: BackendClient | null
  capabilities: AiCapabilities | null
} {
  const { connection, wsStatus } = useStudioCore()
  const online = wsStatus === 'connected' ? connection : null
  const [client, setClient] = useState<BackendClient | null>(null)
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null)
  useEffect(() => {
    if (!online) return
    let disposed = false
    const next = new BackendClient(online)
    next.connect().then(
      () => {
        if (disposed) return
        setClient(next)
        next.request<AiCapabilities>('ai.capabilities.get').then(
          (fresh) => {
            if (!disposed) setCapabilities(fresh)
          },
          () => undefined
        )
      },
      () => undefined
    )
    return () => {
      disposed = true
      next.close()
      setClient(null)
    }
  }, [online])
  return { client, capabilities }
}

/** One controller per client, its state as React state. */
export function useGolemPetCreator(client: GolemPetCreatorClient | null): {
  state: GolemPetCreatorState
  controller: GolemPetCreatorController | null
} {
  const [controller, setController] = useState<GolemPetCreatorController | null>(null)
  useEffect(() => {
    if (!client) return
    const next = createGolemPetCreatorController(client)
    setController(next)
    void next.refresh()
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
const initialState = (): GolemPetCreatorState => INITIAL
