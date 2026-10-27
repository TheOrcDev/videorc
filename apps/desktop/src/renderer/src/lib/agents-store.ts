import { BackendClient } from '@/backendClient'
import { AGENTS_PRESENCE_POLL_MS } from '@/lib/agents-view'
import type {
  AgentActivityEntry,
  AgentBridgeInfo,
  AgentClientKind,
  AgentCreated,
  AgentIntentEvent,
  AgentsStatus,
  BackendConnection
} from '@/lib/backend'
import { offlineError } from '@/lib/user-error'

// Plan 209 S7: the Agents state for the main window, as an external store
// (useSyncExternalStore) rather than Studio provider state, so Settings →
// Remote → Agents, the Studio's Session line, ⌘K and the D11 notices share
// one subscription without growing hooks/use-studio.tsx.
//
// The store opens its own backend client while anything subscribes (the
// pattern of the Discord and privacy rows), narrowed with
// `events.setIncluded` to the three Agents events, and reconnects when main
// hands the window a new connection. `agents.status` and `agents.activity`
// are pushed; the one read on a timer is the status while an agent is
// connected, because the backend publishes nothing when an agent's 45 s
// presence lapses (AGENTS_PRESENCE_POLL_MS).

/** Settings → Remote → Agents → Activity shows the newest hundred (S7). */
export const AGENT_ACTIVITY_ROWS = 100

/** The events this store's socket asks for, and nothing else. */
export const AGENTS_STORE_EVENTS = ['agents.status', 'agents.activity', 'agent.intent'] as const

const RETRY_MS = 3_000
/** A last unsubscribe waits this long, so a remount does not reopen the socket. */
const IDLE_CLOSE_MS = 1_000

export interface AgentsSnapshot {
  /** Null until Videorc answers. */
  status: AgentsStatus | null
  /** Newest first, at most AGENT_ACTIVITY_ROWS, for `activityAgentId` (null: every agent). */
  activity: AgentActivityEntry[]
  activityAgentId: string | null
  activityLoaded: boolean
  /** Where the bridge is and whether this install has it; null until main answers. */
  bridge: AgentBridgeInfo | null
  /** Connect an agent… is open: its button, or ⌘K before Settings had mounted. */
  connectOpen: boolean
  /** Counts each ask to open Connect, so Settings brings the section into view once per ask. */
  connectRequest: number
  /** Videorc can't be reached right now. */
  offline: boolean
}

export type AgentsStoreEvent =
  | { kind: 'activity'; entry: AgentActivityEntry }
  | { kind: 'intent'; intent: AgentIntentEvent }

export type AgentsClient = Pick<
  BackendClient,
  'connect' | 'close' | 'on' | 'request' | 'requestTyped'
>

export interface AgentsStoreDeps {
  getConnection: () => Promise<BackendConnection | null>
  onConnection: (listener: (connection: BackendConnection) => void) => () => void
  createClient: (connection: BackendConnection) => AgentsClient
  getBridge: (install: boolean) => Promise<AgentBridgeInfo>
  timers?: {
    setInterval: (run: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
    setTimeout: (run: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
  }
}

export interface AgentsActions {
  enable: () => Promise<void>
  disable: () => Promise<void>
  /** D12: every agent is cut and Agents turns off. */
  stop: () => Promise<void>
  /** The token exists here once: show it, never keep it. */
  create: (name: string, client: AgentClientKind) => Promise<AgentCreated>
  remove: (id: string) => Promise<void>
  showActivityFor: (agentId: string | null) => Promise<void>
  /** Connect: the bridge's path, with the Linux copy in place (D20). */
  prepareBridge: () => Promise<AgentBridgeInfo>
  openConnect: () => void
  closeConnect: () => void
}

export interface AgentsStore extends AgentsActions {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => AgentsSnapshot
  /** Activity and intents as they arrive, for the D11 notices. */
  onEvent: (listener: (event: AgentsStoreEvent) => void) => () => void
}

const INITIAL: AgentsSnapshot = {
  status: null,
  activity: [],
  activityAgentId: null,
  activityLoaded: false,
  bridge: null,
  connectOpen: false,
  connectRequest: 0,
  offline: false
}

function sameConnection(a: BackendConnection, b: BackendConnection): boolean {
  return a.host === b.host && a.port === b.port && a.token === b.token
}

/** The agent's row learns its last action from the event (the backend
 * publishes no status for an action). */
function withLastAction(status: AgentsStatus, entry: AgentActivityEntry): AgentsStatus {
  if (!status.agents.some((agent) => agent.id === entry.agentId)) return status
  return {
    ...status,
    agents: status.agents.map((agent) =>
      agent.id === entry.agentId
        ? {
            ...agent,
            lastUsedAt: entry.at,
            lastAction: { tool: entry.tool, at: entry.at, outcome: entry.outcome }
          }
        : agent
    )
  }
}

export function createAgentsStore(deps: AgentsStoreDeps): AgentsStore {
  const timers = deps.timers ?? {
    setInterval: (run: () => void, ms: number) => setInterval(run, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
  let snapshot = INITIAL
  const listeners = new Set<() => void>()
  const eventListeners = new Set<(event: AgentsStoreEvent) => void>()
  let started = false
  let ready = false
  let client: AgentsClient | null = null
  let connection: BackendConnection | null = null
  let generation = 0
  let unwatchConnection: (() => void) | null = null
  let pollTimer: unknown = null
  let retryTimer: unknown = null
  let idleTimer: unknown = null

  const set = (patch: Partial<AgentsSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    syncPresencePoll()
    for (const listener of [...listeners]) listener()
  }

  const emit = (event: AgentsStoreEvent): void => {
    for (const listener of [...eventListeners]) listener(event)
  }

  function syncPresencePoll(): void {
    const wanted = started && ready && (snapshot.status?.connectedCount ?? 0) > 0
    if (wanted && pollTimer === null) {
      pollTimer = timers.setInterval(() => void refreshStatus(), AGENTS_PRESENCE_POLL_MS)
    } else if (!wanted && pollTimer !== null) {
      timers.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function refreshStatus(): Promise<void> {
    const active = client
    const at = generation
    if (!active || !ready) return
    try {
      const status = await active.requestTyped('agents.status')
      if (at === generation) set({ status })
    } catch {
      // The next push or beat answers; a failed read never blanks the line.
    }
  }

  function activityParams(agentId: string | null): { limit: number; agentId?: string } {
    return agentId ? { limit: AGENT_ACTIVITY_ROWS, agentId } : { limit: AGENT_ACTIVITY_ROWS }
  }

  function receiveActivity(entry: AgentActivityEntry): void {
    const filter = snapshot.activityAgentId
    const activity =
      filter === null || entry.agentId === filter
        ? [entry, ...snapshot.activity.filter((row) => row.id !== entry.id)].slice(
            0,
            AGENT_ACTIVITY_ROWS
          )
        : snapshot.activity
    set({ activity, status: snapshot.status ? withLastAction(snapshot.status, entry) : null })
    emit({ kind: 'activity', entry })
  }

  function scheduleRetry(at: number): void {
    if (!started || retryTimer !== null) return
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      if (at === generation && started) void seed(at)
    }, RETRY_MS)
  }

  async function seed(at: number): Promise<void> {
    const active = client
    if (!active) return
    try {
      await active.connect()
      if (at !== generation) return
      await active.request('events.setIncluded', { events: [...AGENTS_STORE_EVENTS] })
      const [status, page] = await Promise.all([
        active.requestTyped('agents.status'),
        active.requestTyped('agents.activity.list', activityParams(snapshot.activityAgentId))
      ])
      if (at !== generation) return
      ready = true
      set({
        status,
        activity: page.entries.slice(0, AGENT_ACTIVITY_ROWS),
        activityLoaded: true,
        offline: false
      })
    } catch (error) {
      if (at !== generation) return
      console.warn('[agents] Could not read the Agents status:', error)
      ready = false
      set({ offline: true })
      scheduleRetry(at)
    }
  }

  function detach(): void {
    generation += 1
    ready = false
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer)
      retryTimer = null
    }
    client?.close()
    client = null
    connection = null
    syncPresencePoll()
  }

  function attach(next: BackendConnection): void {
    if (client && connection && sameConnection(connection, next)) return
    detach()
    connection = next
    const at = generation
    const nextClient = deps.createClient(next)
    client = nextClient
    nextClient.on('agents.status', (status) => {
      if (at === generation) set({ status: status as AgentsStatus })
    })
    nextClient.on('agents.activity', (entry) => {
      if (at === generation) receiveActivity(entry as AgentActivityEntry)
    })
    nextClient.on('agent.intent', (intent) => {
      if (at === generation) emit({ kind: 'intent', intent: intent as AgentIntentEvent })
    })
    nextClient.on('connection.closed', () => {
      if (at !== generation) return
      ready = false
      set({ offline: true })
      scheduleRetry(at)
    })
    void seed(at)
  }

  function start(): void {
    started = true
    unwatchConnection = deps.onConnection((next) => {
      if (started) attach(next)
    })
    void deps
      .getConnection()
      .then((next) => {
        if (started && next) attach(next)
      })
      .catch(() => set({ offline: true }))
    void deps
      .getBridge(false)
      .then((bridge) => set({ bridge }))
      .catch((error: unknown) => console.warn('[agents] Could not find the agent bridge:', error))
  }

  function shutdown(): void {
    started = false
    unwatchConnection?.()
    unwatchConnection = null
    detach()
  }

  async function call<T>(run: (active: AgentsClient) => Promise<T>): Promise<T> {
    if (!client || !ready) throw offlineError()
    return run(client)
  }

  const showActivityFor = async (agentId: string | null): Promise<void> => {
    set({ activityAgentId: agentId, activityLoaded: false })
    const page = await call((active) =>
      active.requestTyped('agents.activity.list', activityParams(agentId))
    )
    if (snapshot.activityAgentId !== agentId) return
    set({ activity: page.entries.slice(0, AGENT_ACTIVITY_ROWS), activityLoaded: true })
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (idleTimer !== null) {
        timers.clearTimeout(idleTimer)
        idleTimer = null
      }
      if (!started) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0 || idleTimer !== null) return
        idleTimer = timers.setTimeout(() => {
          idleTimer = null
          if (listeners.size === 0) shutdown()
        }, IDLE_CLOSE_MS)
      }
    },
    getSnapshot: () => snapshot,
    onEvent(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
    async enable() {
      set({ status: await call((active) => active.requestTyped('agents.enable')) })
    },
    async disable() {
      set({ status: await call((active) => active.requestTyped('agents.disable')) })
    },
    async stop() {
      set({ status: await call((active) => active.requestTyped('agents.stop')) })
    },
    async create(name, kind) {
      return call((active) => active.requestTyped('agents.create', { name, client: kind }))
    },
    async remove(id) {
      set({ status: await call((active) => active.requestTyped('agents.remove', { id })) })
      if (snapshot.activityAgentId === id) await showActivityFor(null)
    },
    showActivityFor,
    async prepareBridge() {
      const bridge = await deps.getBridge(true)
      set({ bridge })
      return bridge
    },
    openConnect() {
      set({ connectOpen: true, connectRequest: snapshot.connectRequest + 1 })
    },
    closeConnect() {
      set({ connectOpen: false })
    }
  }
}

let mainWindowStore: AgentsStore | null = null

/** The main window's one Agents store. */
export function agentsStore(): AgentsStore {
  mainWindowStore ??= createAgentsStore({
    getConnection: () => window.videorc?.getBackendConnection?.() ?? Promise.resolve(null),
    onConnection: (listener) => window.videorc?.onBackendConnection?.(listener) ?? (() => {}),
    createClient: (connection) => new BackendClient(connection),
    getBridge: (install) =>
      window.videorc?.getAgentBridge
        ? window.videorc.getAgentBridge(install)
        : Promise.reject(new Error('The agent bridge is only known in the main window.'))
  })
  return mainWindowStore
}
