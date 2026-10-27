import { useSyncExternalStore } from 'react'

import { agentsStore, type AgentsActions, type AgentsSnapshot } from '@/lib/agents-store'

/**
 * Plan 209 S7: the Agents state (status, the newest Activity, the bridge,
 * whether Connect is open), from the main window's one store. Subscribing
 * keeps its socket open; the last subscriber to leave closes it.
 */
export function useAgents(): AgentsSnapshot {
  const store = agentsStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** The Agents actions. Stable: the store outlives every component. */
export function useAgentsActions(): AgentsActions {
  return agentsStore()
}
