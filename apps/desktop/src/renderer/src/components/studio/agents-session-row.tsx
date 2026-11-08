import { TerminalIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { LCD_VALUE_BUTTON, LcdPanelLabel, type StudioLook } from '@/components/lcd-panel'
import { NavigableRow } from '@/components/navigable-row'
import { Button } from '@/components/ui/button'
import { LcdDisplayRow } from '@/components/ui/lcd-display'
import { useAgents, useAgentsActions } from '@/hooks/use-agents'
import { STOP_AGENTS_COMMAND, agentsSessionLine } from '@/lib/agents-view'
import { toastUserError } from '@/lib/user-error'
import { cn } from '@/lib/utils'

/**
 * D12: while an agent is connected, one Session line says so ("Claude
 * Desktop connected", "2 agents connected") with Stop, which cuts every
 * agent and turns Agents off at once. A safety stop never asks; turning
 * Agents back on is one switch in Settings → Remote. Nothing while none is
 * connected, and never in the toolbar (owner rule).
 */
export function AgentsSessionRow({ look = 'default' }: { look?: StudioLook }): ReactElement | null {
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

  if (look === 'lcd') {
    // The screen's row, with the line free to shorten: an agent's name can be
    // long, and Stop must never leave the screen.
    return (
      <LcdDisplayRow className="min-w-0 gap-4 py-2">
        <LcdPanelLabel className="min-w-0 shrink truncate">{line}</LcdPanelLabel>
        <button
          aria-label={STOP_AGENTS_COMMAND}
          className={cn(LCD_VALUE_BUTTON, 'shrink-0')}
          data-testid="session-agents-stop"
          disabled={stopping}
          type="button"
          onClick={onStop}
        >
          Stop
        </button>
      </LcdDisplayRow>
    )
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
