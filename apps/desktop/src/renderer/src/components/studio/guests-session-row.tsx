import type { ReactElement } from 'react'

import { AccountIcon } from '@/components/icons'
import { LcdPanelNavRow, type StudioLook } from '@/components/lcd-panel'
import { NavigableRow } from '@/components/navigable-row'
import { useStudioCloud } from '@/hooks/use-studio'
import { guestsSessionValue, roomPeople } from '@/lib/guests-view'
import { openLivestreamView } from '@/lib/livestream-tabs'

/**
 * The Studio's one Guests row while the room is open (plan 224 D16): "Room
 * open · 2 backstage", and a click opens Livestream → Guests, the room's one
 * home. Its own chunk: it loads with the room, never with the Studio.
 */
export function GuestsSessionRow({ look = 'default' }: { look?: StudioLook }): ReactElement {
  const { cloudStatus, talkShow } = useStudioCloud()
  const room = cloudStatus?.room
  const value = guestsSessionValue(room, roomPeople(room, talkShow.hostIdentity))
  const open = (): void => openLivestreamView('guests')
  return look === 'lcd' ? (
    <LcdPanelNavRow label="Guests" value={value} onNavigate={open} />
  ) : (
    <NavigableRow icon={AccountIcon} label="Guests" value={value} onNavigate={open} />
  )
}
