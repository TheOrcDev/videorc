import { useSyncExternalStore } from 'react'

import { useAgents } from '@/hooks/use-agents'
import { startAgentNotices } from '@/lib/agent-notices'
import { agentsStore } from '@/lib/agents-store'

// The notices run while this is mounted: a subscription, not an effect.
const subscribeNotices = (): (() => void) => startAgentNotices(agentsStore())
const noState = (): number => 0

/**
 * Plan 209 S7: keeps the main window's Agents store open on every page, so
 * the D11 notices show wherever the streamer is and the Studio's Session
 * line and ⌘K read a current status. Renders nothing. Each notice is the
 * backend's sentence on the `agents.activity` event, toasted once. The
 * shell loads it lazily, so the Agents store stays out of the eager bundle.
 */
export function AgentsWatcher(): null {
  useAgents()
  useSyncExternalStore(subscribeNotices, noState)
  return null
}
