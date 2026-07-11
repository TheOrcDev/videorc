import type { ReactElement } from 'react'

import { CaptionPreview } from '@/components/captions/caption-preview'
import { CaptionsControls } from '@/components/captions/captions-controls'

export function CaptionsTab(): ReactElement {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(380px,0.8fr)]">
      <CaptionPreview />
      <CaptionsControls />
    </div>
  )
}
