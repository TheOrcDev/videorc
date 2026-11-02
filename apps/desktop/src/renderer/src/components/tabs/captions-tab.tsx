import type { ReactElement } from 'react'

import { CaptionPreview } from '@/components/captions/caption-preview'
import { CaptionsControls } from '@/components/captions/captions-controls'
import { CAPTIONS_GRID, PAGE_LEAD_COLUMN, PAGE_TRAIL_COLUMN } from '@/lib/page-layout'

export function CaptionsTab(): ReactElement {
  return (
    <div className={CAPTIONS_GRID}>
      <div className={PAGE_LEAD_COLUMN}>
        <CaptionPreview />
      </div>
      <div className={PAGE_TRAIL_COLUMN}>
        <CaptionsControls />
      </div>
    </div>
  )
}
