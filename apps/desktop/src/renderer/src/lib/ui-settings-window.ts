// This window's UI settings store (plan 220 S1.4a) and how it reaches the
// engine: the main window over its own backend socket (the renderer role),
// the Stream Manager, Captions and Notes windows over main's relay
// (`getUiSettings`/`setUiSettings`/`onUiSettingsChanged`), because those
// windows hold no socket by design (`preload/api-policy.ts`). Each window
// entry awaits `hydrateUiSettingsBeforeFirstRender()` before its first
// render; the main window's wait is bounded by `UI_SETTINGS_HYDRATE_TIMEOUT_MS`.

import { BackendClient } from '@/backendClient'

import type {
  BackendConnection,
  UiSettingsChange,
  UiSettingsGetParams,
  UiSettingsSetParams,
  UiSettingsSnapshot,
  VideorcApi
} from '../../../shared/backend'
import {
  createUiSettingsStore,
  UI_SETTINGS_HYDRATE_TIMEOUT_MS,
  UiSettingsPermanentError,
  type UiSettingsHydration,
  type UiSettingsStore,
  type UiSettingsTransport
} from './ui-settings-store'

export interface BackendUiSettingsTransportDeps {
  getConnection: () => Promise<BackendConnection | null>
  onConnection: (listener: (connection: BackendConnection) => void) => () => void
  createClient: (connection: BackendConnection) => BackendClient
}

/**
 * The main window's transport: one socket of its own, reopened on the next
 * request after the engine drops or restarts (a new connection from main
 * replaces the old one). `onReconnect` fires after every successful connect.
 */
export function createBackendUiSettingsTransport(
  deps: BackendUiSettingsTransportDeps
): UiSettingsTransport {
  const changeListeners = new Set<(change: UiSettingsChange) => void>()
  const reconnectListeners = new Set<() => void>()
  let client: BackendClient | null = null
  let clientConnection: BackendConnection | null = null
  let latest: BackendConnection | null = null
  let connecting: Promise<BackendClient> | null = null
  let closed = false
  const waiters = new Set<(connection: BackendConnection) => void>()

  const offConnection = deps.onConnection((connection) => {
    latest = connection
    if (
      client &&
      clientConnection &&
      (clientConnection.host !== connection.host ||
        clientConnection.port !== connection.port ||
        clientConnection.token !== connection.token)
    ) {
      // A new engine: the old socket is dead or about to be.
      client.close()
      client = null
      clientConnection = null
    }
    for (const waiter of [...waiters]) waiter(connection)
    waiters.clear()
  })

  function sameConnection(a: BackendConnection, b: BackendConnection): boolean {
    return a.host === b.host && a.port === b.port && a.token === b.token
  }

  async function waitForConnection(): Promise<BackendConnection> {
    const known = latest ?? (await deps.getConnection())
    if (known) {
      latest = known
      return known
    }
    return new Promise<BackendConnection>((resolve) => {
      waiters.add(resolve)
    })
  }

  async function ensureClient(): Promise<BackendClient> {
    if (closed) throw new Error("This window's engine access is closed.")
    if (client?.connected) return client
    if (connecting) return connecting
    connecting = (async () => {
      const connection = await waitForConnection()
      if (closed) throw new Error("This window's engine access is closed.")
      if (client && clientConnection && sameConnection(clientConnection, connection)) {
        client.close()
      }
      const next = deps.createClient(connection)
      next.on('ui.settings.changed', (change) => {
        for (const listener of changeListeners) listener(change)
      })
      next.on('connection.closed', () => {
        if (client === next) {
          client = null
          clientConnection = null
        }
      })
      await next.connect()
      client = next
      clientConnection = connection
      for (const listener of reconnectListeners) listener()
      return next
    })().finally(() => {
      connecting = null
    })
    return connecting
  }

  return {
    async get(params?: UiSettingsGetParams): Promise<UiSettingsSnapshot> {
      const active = await ensureClient()
      return active.requestTyped('ui.settings.get', params)
    },
    async set(params: UiSettingsSetParams): Promise<UiSettingsChange> {
      const active = await ensureClient()
      return active.requestTyped('ui.settings.set', params)
    },
    onChange(listener) {
      changeListeners.add(listener)
      return () => {
        changeListeners.delete(listener)
      }
    },
    onReconnect(listener) {
      reconnectListeners.add(listener)
      return () => {
        reconnectListeners.delete(listener)
      }
    },
    close() {
      closed = true
      offConnection()
      waiters.clear()
      client?.close()
      client = null
      clientConnection = null
    }
  }
}

/** The socket-less windows' transport: main's relay over its admin lane. */
export function createRelayUiSettingsTransport(
  api: Pick<VideorcApi, 'getUiSettings' | 'setUiSettings' | 'onUiSettingsChanged'>
): UiSettingsTransport {
  return {
    get: (params) => api.getUiSettings(params),
    set: (params) => api.setUiSettings(params),
    onChange: (listener) => api.onUiSettingsChanged(listener)
  }
}

/** A window with neither: every request names why. */
export function createUnavailableUiSettingsTransport(reason: string): UiSettingsTransport {
  return {
    get: () => Promise.reject(new UiSettingsPermanentError(reason)),
    set: () => Promise.reject(new UiSettingsPermanentError(reason)),
    onChange: () => () => {}
  }
}

function storageOrNull(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Which transport this window gets, from the API the preload handed it. */
export function windowUiSettingsTransport(
  api: Partial<VideorcApi> | undefined = typeof window === 'undefined'
    ? undefined
    : (window.videorc as Partial<VideorcApi> | undefined)
): UiSettingsTransport {
  if (api?.getBackendConnection && api.onBackendConnection) {
    const { getBackendConnection, onBackendConnection } = api
    return createBackendUiSettingsTransport({
      getConnection: () => getBackendConnection(),
      onConnection: (listener) => onBackendConnection(listener),
      createClient: (connection) => new BackendClient(connection)
    })
  }
  if (api?.getUiSettings && api.setUiSettings && api.onUiSettingsChanged) {
    return createRelayUiSettingsTransport({
      getUiSettings: api.getUiSettings,
      setUiSettings: api.setUiSettings,
      onUiSettingsChanged: api.onUiSettingsChanged
    })
  }
  return createUnavailableUiSettingsTransport(
    "This window can't reach Videorc's settings. Restart Videorc if this keeps happening."
  )
}

let store: UiSettingsStore | null = null

/** This window's one store. */
export function uiSettingsStore(): UiSettingsStore {
  store ??= createUiSettingsStore({
    transport: windowUiSettingsTransport(),
    storage: storageOrNull()
  })
  return store
}

/**
 * Every window entry awaits this before its first render: the snapshot, the
 * one-time `localStorage` migration and the journal replay. It never throws;
 * past the deadline the window renders with the store `unavailable` and the
 * store keeps trying (the console names it).
 */
export async function hydrateUiSettingsBeforeFirstRender(
  timeoutMs = UI_SETTINGS_HYDRATE_TIMEOUT_MS
): Promise<UiSettingsHydration> {
  const result = await uiSettingsStore().hydrate({ timeoutMs })
  if (result.state === 'hydrated' && (result.migrated > 0 || result.replayed > 0)) {
    console.info(
      `[ui-settings] hydrated at revision ${result.revision}: migrated ${result.migrated} localStorage key(s), replayed ${result.replayed} journaled write(s).`
    )
  }
  return result
}
