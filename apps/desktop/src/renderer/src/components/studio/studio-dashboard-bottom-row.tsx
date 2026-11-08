import type { ReactElement } from 'react'

import { ScenesGallery } from '@/components/studio/scenes-gallery'
import { SoundboardSection } from '@/components/studio/soundboard-section'
import { VerticalLegMonitor } from '@/components/studio/vertical-leg-monitor'

/**
 * Below-the-fold Studio controls. Keeping this row in one deferred chunk lets
 * the launch surface paint its preview and session controls before parsing the
 * richer scene editors, and keeps audiocn's sound pads out of the eager
 * bundle (plan 189). The microphone lives in the inspector (plan 092).
 */
export function StudioDashboardBottomRow(): ReactElement {
  return (
    <div className="flex flex-col">
      <ScenesGallery />
      <SoundboardSection />
      <VerticalLegMonitor />
    </div>
  )
}
