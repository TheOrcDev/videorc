import { useEffect, useState, type ReactElement } from 'react'

import { Spinner } from '@/components/ui/spinner'
import { useStudioCore, useStudioPreview } from '@/hooks/use-studio'
import {
  SCENE_SWITCH_PENDING_LABEL,
  SCENE_SWITCH_STATUS_DELAY_MS,
  sceneSwitchStatusLine,
  sceneSwitchStatusVisible
} from '@/lib/scene-switch-progress'

/**
 * The pending mark beside the name of the scene or layout being applied
 * (issue #1275): the name stays, and this says it is on its way. The status
 * line under the list announces it, so the mark stays silent.
 */
export function SceneSwitchPending({ label = true }: { label?: boolean }): ReactElement {
  return (
    <span className="inline-flex items-center gap-1" data-slot="scene-switch-pending">
      <Spinner aria-hidden className="size-3.5 shrink-0" />
      {label ? SCENE_SWITCH_PENDING_LABEL : null}
    </span>
  )
}

/**
 * One line under a scene list while a switch runs past a moment: the name
 * that was clicked and what the switch is waiting for, then the switch it
 * replaced or a slow camera when that is the reason. Nothing while no switch
 * runs, or for its first moment (a quick switch never shows it).
 */
export function SceneSwitchStatus(): ReactElement | null {
  const { sceneSwitchProgress: progress, captureConfig, deviceList } = useStudioCore()
  const { previewCameraLowFrameRate } = useStudioPreview()
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!progress) return
    const waitMs = progress.startedAtMs + SCENE_SWITCH_STATUS_DELAY_MS - Date.now()
    if (waitMs <= 0) {
      setNowMs(Date.now())
      return
    }
    const timer = setTimeout(() => setNowMs(Date.now()), waitMs)
    return () => clearTimeout(timer)
  }, [progress])
  if (!progress || !sceneSwitchStatusVisible(progress, nowMs)) return null
  const cameraId = captureConfig.sources.cameraId
  const cameraName = cameraId
    ? deviceList.devices.find((device) => device.id === cameraId)?.name
    : undefined
  const { title, detail } = sceneSwitchStatusLine(progress, {
    name: cameraName,
    lowFrameRate: previewCameraLowFrameRate
  })
  return (
    <p
      aria-live="polite"
      className="flex items-start gap-1.5 text-xs text-muted-foreground"
      data-slot="scene-switch-status"
      role="status"
    >
      <Spinner aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="text-foreground">{title}</span>
        {detail ? ` ${detail}` : null}
      </span>
    </p>
  )
}
