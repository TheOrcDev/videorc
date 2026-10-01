import { useMemo, useRef } from 'react'

import { useStudioMicVisualPipeline } from '@/hooks/use-studio-mic-visual'
import type { FrameSource, MeterFrame } from '@/lib/audio/types'
import { createMicMeterSource, type MicMeterSettings } from '@/lib/mic-frame-sources'

// Plan 092: audiocn frame sources over the workspace's visual mic pipeline.
// Only lazy chunks (the Studio dashboard, the Studio tab, Sources) import this
// module, so the adapters and audiocn's core stay out of the eager bundle.

/**
 * The Studio microphone as a meter source: what the recording will hear (the
 * configured gain added, silence while muted). One stable source per
 * pipeline; gain and mute are read on every frame, so a Gain drag never
 * re-subscribes or reopens the device.
 */
export function useStudioMicMeterSource(settings: MicMeterSettings): FrameSource<MeterFrame> {
  const pipeline = useStudioMicVisualPipeline()
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  return useMemo(() => createMicMeterSource(pipeline, () => settingsRef.current), [pipeline])
}
