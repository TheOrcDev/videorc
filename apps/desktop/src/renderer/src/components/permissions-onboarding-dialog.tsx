import { ArrowRight, CircleNotch } from '@phosphor-icons/react'
import { useEffect, useState, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useStudioAudio, useStudioCore } from '@/hooks/use-studio'
import { isWindowsPlatform, osSettingsName } from '@/lib/platform'
import {
  systemAccessAction,
  systemAccessRows,
  type SystemAccessAction,
  type SystemAccessRow
} from '@/lib/system-access'

// Permissions-only onboarding: the ONE thing a fresh install needs is macOS
// grants, so this is the whole flow — three rows sharing the exact state
// derivation Settings' System access section uses (system-access.ts, never
// guessed), with the grant action each permission actually supports. The
// dialog only mounts when a grant is missing (see app-shell's gate).
export function PermissionsOnboardingDialog({
  open,
  onComplete
}: {
  open: boolean
  onComplete: () => void
}): ReactElement {
  const { deviceList, refreshBackend, handleSystemPermission, runtimeInfo, mediaAccess } =
    useStudioCore()
  const { audioMeter } = useStudioAudio()
  const [pending, setPending] = useState<SystemAccessRow['id'] | null>(null)

  // Grants flip in System Settings or the native prompt while we may be
  // backgrounded — re-enumerate on focus so the chips stay honest (same
  // pattern as Settings ST3).
  useEffect(() => {
    if (!open) {
      return
    }
    const onFocus = (): void => void refreshBackend()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [open, refreshBackend])

  const rows = systemAccessRows({
    deviceList,
    audioMeter,
    platform: runtimeInfo?.platform,
    mediaAccess
  })
  const allPermissionsResolved = rows.every(
    (row) => row.state === 'granted' || row.state === 'device-issue'
  )
  const isWindows = isWindowsPlatform(runtimeInfo?.platform)
  const deviceNoun = isWindows ? 'PC' : 'Mac'
  const settingsName = osSettingsName(runtimeInfo?.platform)

  const runPermissionAction = async (pane: SystemAccessRow['id']): Promise<void> => {
    setPending(pane)
    try {
      await handleSystemPermission(pane)
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onComplete()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <img alt="Videorc" className="size-14 object-contain" src={logoUrl} />
            <div className="flex flex-col gap-1">
              <DialogTitle>Let Videorc capture your {deviceNoun}</DialogTitle>
              <DialogDescription>
                {isWindows
                  ? `Turn on camera and microphone access in ${settingsName}. You can change any of this later in Settings.`
                  : 'macOS asks once per permission. Grant what you need — you can change any of this later in Settings.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-1">
          {rows.map((row) => (
            <PermissionRow
              key={row.id}
              action={systemAccessAction({
                pane: row.id,
                state: row.state,
                platform: runtimeInfo?.platform,
                mediaAccessStatus:
                  row.id === 'camera' || row.id === 'microphone' ? mediaAccess?.[row.id] : undefined
              })}
              pending={pending === row.id}
              row={row}
              onAction={() => void runPermissionAction(row.id)}
            />
          ))}
        </div>

        {isWindows ? (
          <p className="text-xs text-muted-foreground">
            Videorc runs as a desktop app, so it won’t appear by name in {settingsName}. In each
            privacy page, turn on the main access toggle and “Let desktop apps access your camera /
            microphone.”
          </p>
        ) : null}

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Recordings stay on this {deviceNoun}. Cloud AI only runs after you opt in.
          </span>
          <Button onClick={onComplete}>
            {allPermissionsResolved ? 'Continue' : 'Continue without granting'}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PermissionRow({
  row,
  action,
  pending,
  onAction
}: {
  row: SystemAccessRow
  action: SystemAccessAction
  pending: boolean
  onAction: () => void
}): ReactElement {
  const actionButton =
    action === 'request-media-access' ? (
      <Button disabled={pending} size="xs" variant="outline" onClick={onAction}>
        {pending ? <CircleNotch className="animate-spin" data-icon="inline-start" /> : null}
        Enable
      </Button>
    ) : action === 'open-settings' ? (
      <Button disabled={pending} size="xs" variant="outline" onClick={onAction}>
        Open settings
      </Button>
    ) : null

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-row border bg-muted/30 px-3 py-2.5 text-sm">
      <span className="w-36 shrink-0 font-medium">{row.label}</span>
      <StatusBadge
        tone={
          row.state === 'granted'
            ? 'good'
            : row.state === 'not-granted' || row.state === 'device-issue'
              ? 'warn'
              : 'neutral'
        }
        value={
          row.state === 'granted'
            ? 'Granted'
            : row.state === 'not-granted'
              ? 'Not granted'
              : row.state === 'device-issue'
                ? 'Device issue'
                : 'Checked on first use'
        }
      />
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={row.detail}>
        {row.purpose}
      </span>
      {actionButton}
    </div>
  )
}
