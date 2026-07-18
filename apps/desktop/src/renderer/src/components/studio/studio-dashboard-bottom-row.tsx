import type { ReactElement } from 'react'

import { AudioMixer } from '@/components/studio/audio-mixer'
import { ScenesGallery } from '@/components/studio/scenes-gallery'

/**
 * Below-the-fold Studio controls. Keeping this row in one deferred chunk lets
 * the launch surface paint its preview and session controls before parsing the
 * richer scene and audio editors.
 */
export function StudioDashboardBottomRow(): ReactElement {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <ScenesGallery />
      <AudioMixer />
    </div>
  )
}
