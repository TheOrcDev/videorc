import type { ReactElement } from 'react'

import { PanelSection } from '@/components/panel-section'
import { ScenesGallery } from '@/components/studio/scenes-gallery'
import { SoundboardSection } from '@/components/studio/soundboard-section'
import { VerticalLegMonitor } from '@/components/studio/vertical-leg-monitor'
import { useStudioCloud } from '@/hooks/use-studio'
import { SCENES_OFF_WHILE_ROOM_OPEN } from '@/lib/guests-view'

/**
 * Below-the-fold Studio controls. Keeping this row in one deferred chunk lets
 * the launch surface paint its preview and session controls before parsing the
 * richer scene editors, and keeps audiocn's sound pads out of the eager
 * bundle (plan 189). The microphone lives in the inspector (plan 092).
 */
export function StudioDashboardBottomRow(): ReactElement {
  const { cloudStatus } = useStudioCloud()
  // While the room is open the Show stage's layouts are what goes on air; a
  // scene would change only this computer's picture (plan 224, out of scope).
  const roomOpen = cloudStatus?.room?.phase === 'open'
  return (
    <div className="flex flex-col">
      {roomOpen ? (
        <PanelSection description={SCENES_OFF_WHILE_ROOM_OPEN} title="Scenes" />
      ) : (
        <ScenesGallery />
      )}
      <SoundboardSection />
      <VerticalLegMonitor />
    </div>
  )
}
