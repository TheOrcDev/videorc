import { FolderIcon } from '@/components/icons'
import { useState, type ReactElement } from 'react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useStudioCore } from '@/hooks/use-studio'
import { OPEN_HEALTH_LABEL, openHealth } from '@/lib/health-door'
import { sourcePermissionAlerts, type SourcePermissionAlert } from '@/lib/source-permissions'
import { unknownDeviceWarnings } from '@/lib/source-status'
import {
  isMediaAccessSnapshotReady,
  systemAccessAction,
  mediaAccessStatusForPane
} from '@/lib/system-access'
import { useSystemAccessRows } from '@/hooks/use-system-access-rows'
import { cn } from '@/lib/utils'

// Plan 174 S3.8 (C-8, C-14): the Sources page's one place for what blocks a
// source. One flush warning Alert per missing permission, with its fix, and
// one quiet line when the device list carries anything else, which Health
// shows in full. Raw backend text never reaches this page.

export function SourcePermissionAlertsView({
  alerts,
  deviceProblem,
  onOpen,
  onReveal,
  onOpenHealth,
  className
}: {
  alerts: readonly SourcePermissionAlert[]
  /** The device list has warnings no alert covers. */
  deviceProblem: boolean
  onOpen: (id: SourcePermissionAlert['id']) => Promise<void> | void
  onReveal: () => void
  onOpenHealth: () => void
  /** Layout only: Sources pads it under its strip; a dialog body does not. */
  className?: string
}): ReactElement | null {
  const [pending, setPending] = useState<SourcePermissionAlert['id'] | null>(null)
  if (alerts.length === 0 && !deviceProblem) return null

  const open = async (id: SourcePermissionAlert['id']): Promise<void> => {
    setPending(id)
    try {
      await onOpen(id)
    } finally {
      setPending(null)
    }
  }

  return (
    <div
      className={cn('flex flex-col gap-2 px-gutter pt-3', className)}
      data-videorc-source-alerts=""
    >
      {alerts.map((alert) => (
        <Alert key={alert.id} data-permission={alert.id} variant="warning">
          <AlertTitle>{alert.title}</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>{alert.description}</span>
            <span className="flex flex-wrap gap-2">
              <Button
                disabled={pending !== null}
                variant="outline"
                onClick={() => void open(alert.id)}
              >
                {pending === alert.id ? <Spinner aria-hidden data-icon="inline-start" /> : null}
                {alert.actionLabel}
              </Button>
              {alert.revealLabel ? (
                <Button variant="ghost" onClick={onReveal}>
                  <FolderIcon data-icon="inline-start" />
                  {alert.revealLabel}
                </Button>
              ) : null}
            </span>
          </AlertDescription>
        </Alert>
      ))}
      {deviceProblem ? (
        <Alert data-videorc-device-problem="" variant="quiet">
          <AlertTitle>Videorc couldn&apos;t check every device.</AlertTitle>
          <AlertDescription className="pt-1">
            <Button className="-ml-2" size="xs" variant="ghost" onClick={onOpenHealth}>
              {OPEN_HEALTH_LABEL}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

/**
 * The alerts, wired to the studio. `only` keeps one permission's alert, for
 * a place that needs just that one (New scene… needs Screen Recording,
 * plan 210 S5), in the same words as Sources.
 */
export function SourcePermissionAlerts({
  only,
  className
}: { only?: SourcePermissionAlert['id']; className?: string } = {}): ReactElement | null {
  const {
    deviceList,
    captureConfig,
    runtimeInfo,
    mediaAccess,
    handleSystemPermission,
    revealPermissionTarget
  } = useStudioCore()
  const platform = runtimeInfo?.platform
  const targetName = runtimeInfo?.permissionTargetName ?? 'Videorc'
  const rows = useSystemAccessRows()
  const screen = rows.find((row) => row.id === 'screen-recording')
  // Before the OS has answered, "first use" is a guess: no alert on a guess.
  const accessKnown = isMediaAccessSnapshotReady(mediaAccess)
  const media = (pane: 'camera' | 'microphone', chosen: boolean) => {
    const state = accessKnown ? rows.find((row) => row.id === pane)?.state : undefined
    return {
      state,
      detail: rows.find((row) => row.id === pane)?.detail,
      action: systemAccessAction({
        pane,
        checking: rows.find((row) => row.id === pane)?.checking,
        state,
        platform,
        mediaAccessStatus: mediaAccess?.[pane]
      }),
      chosen
    }
  }
  const alerts = sourcePermissionAlerts({
    platform,
    targetName,
    // System audio rides on the same grant as the screen.
    screenRecording: false,
    screen: screen
      ? {
          row: screen,
          action: systemAccessAction({
            pane: 'screen-recording',
            state: screen.state,
            checking: screen.checking,
            platform,
            mediaAccessStatus: mediaAccessStatusForPane(mediaAccess, 'screen-recording')
          })
        }
      : undefined,
    camera: media('camera', Boolean(captureConfig.sources.cameraId)),
    microphone: media('microphone', Boolean(captureConfig.sources.microphoneId))
  })

  return (
    <SourcePermissionAlertsView
      alerts={only ? alerts.filter((alert) => alert.id === only) : alerts}
      className={className}
      deviceProblem={!only && unknownDeviceWarnings(deviceList.warnings).length > 0}
      onOpen={(id) => handleSystemPermission(id)}
      onOpenHealth={openHealth}
      onReveal={() => void revealPermissionTarget()}
    />
  )
}
