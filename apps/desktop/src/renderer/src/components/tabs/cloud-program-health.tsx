import { useEffect, useMemo, useState, type ReactElement } from 'react'

import { GroupedList, ListRow } from '@/components/list-row'
import { PanelSection } from '@/components/panel-section'
import { StatusBadge } from '@/components/status-badge'
import { useStudioCloud } from '@/hooks/use-studio'
import { roomMicrophoneState } from '@/lib/room-microphone-state'
import {
  PROGRAM_PREVIEW_NOTE,
  programHealthRows,
  type ProgramHealthLayer,
  type ProgramHealthMicrophone
} from '../../../../shared/cloud-program-health'

// Plan 249 S26: Health's cloud room section. While this computer holds an
// open room it lists each layer: what reaches the room, what each program
// page reports, and each output's egress, so a missing microphone, a page
// that stopped reporting and a failed output read as three different things.
// Plan 253 S7 adds how long Videorc Cloud took to answer the show's commands.
// It lives in Health's lazy chunk and reads the room microphone's store
// every two seconds, never at its 20 Hz meter rate.

const LAYER_LABEL: Record<ProgramHealthLayer, string> = {
  contribution: 'In the room',
  page: 'Program pages',
  egress: 'Outputs',
  control: 'Videorc Cloud'
}

const MICROPHONE_FRESH_MS = 500

function readMicrophone(): ProgramHealthMicrophone {
  const snapshot = roomMicrophoneState.getSnapshot()
  return {
    state: snapshot.state,
    levelFresh:
      snapshot.state === 'published' &&
      snapshot.observedAt !== null &&
      performance.now() - snapshot.observedAt < MICROPHONE_FRESH_MS
  }
}

export function CloudProgramHealth(): ReactElement | null {
  const { cloudStatus } = useStudioCloud()
  const [microphone, setMicrophone] = useState<ProgramHealthMicrophone>(readMicrophone)
  useEffect(() => {
    const timer = window.setInterval(() => setMicrophone(readMicrophone()), 2000)
    return () => window.clearInterval(timer)
  }, [])
  const room = cloudStatus?.room
  const open = room?.phase === 'open'
  const rows = useMemo(
    () =>
      open
        ? programHealthRows({
            room,
            outputHealth: cloudStatus?.outputHealth,
            show: cloudStatus?.show,
            microphone,
            commandTimes: cloudStatus?.commandTimes
          })
        : [],
    [
      open,
      room,
      cloudStatus?.outputHealth,
      cloudStatus?.show,
      cloudStatus?.commandTimes,
      microphone
    ]
  )
  if (!open) return null
  const layers = (['contribution', 'page', 'egress', 'control'] as const)
    .map((layer) => ({ layer, rows: rows.filter((row) => row.layer === layer) }))
    .filter((group) => group.rows.length > 0)
  return (
    <PanelSection
      data-testid="cloud-program-health"
      description={PROGRAM_PREVIEW_NOTE}
      title="Cloud room"
    >
      <div className="flex flex-col gap-3">
        {layers.map((group) => (
          <GroupedList key={group.layer} label={LAYER_LABEL[group.layer]}>
            {group.rows.map((row) => (
              <ListRow
                key={row.id}
                compact
                context={row.detail}
                data-health-layer={row.layer}
                data-health-row={row.id}
                meta={<StatusBadge tone={row.tone} value={row.status} />}
                title={row.label}
              />
            ))}
          </GroupedList>
        ))}
      </div>
    </PanelSection>
  )
}
