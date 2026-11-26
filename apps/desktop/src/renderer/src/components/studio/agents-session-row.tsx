import { TerminalIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { NavigableRow } from '@/components/navigable-row'
import { Button } from '@/components/ui/button'
import { useAgents, useAgentsActions } from '@/hooks/use-agents'
import { STOP_AGENTS_COMMAND, agentsSessionLine } from '@/lib/agents-view'
import { toastUserError } from '@/lib/user-error'

/**
 * D12: while an agent is connected, one Session line says so ("Claude
 * Desktop connected", "2 agents connected") with Stop, which cuts every
 * agent and turns Agents off at once. A safety stop never asks; turning
 * Agents back on is one switch in Settings → Remote. Nothing while none is
 * connected, and never in the toolbar (owner rule).
 */
export function AgentsSessionRow(): ReactElement | null {
  const { status } = useAgents()
  const { stop } = useAgentsActions()
  const [stopping, setStopping] = useState(false)
  const line = agentsSessionLine(status)
  if (!line) return null

  const onStop = (): void => {
    setStopping(true)
    void stop()
      .catch((error: unknown) => toastUserError(error, { action: 'stop', object: 'the agents' }))
      .finally(() => setStopping(false))
  }

  return (
    <NavigableRow
      icon={TerminalIcon}
      label={line}
      value={
        <Button
          aria-label={STOP_AGENTS_COMMAND}
          data-testid="session-agents-stop"
          disabled={stopping}
          size="xs"
          variant="ghost"
          onClick={onStop}
        >
          Stop
        </Button>
      }
    />
  )
}
