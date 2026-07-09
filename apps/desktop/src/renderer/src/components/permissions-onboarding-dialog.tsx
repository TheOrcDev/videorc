import { ArrowRight, CircleNotch } from '@phosphor-icons/react'
import { useEffect, useRef, useState, type ReactElement } from 'react'

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
import { useStudio } from '@/hooks/use-studio'
import { isWindowsPlatform, osSettingsName } from '@/lib/platform'
import { systemAccessRows, type SystemAccessRow } from '@/lib/system-access'

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
  const {
    deviceList,
    audioMeter,
    wsStatus,
    refreshBackend,
    openSystemPermission,
    sampleAudioMeter,
    canSampleAudio,
    runtimeInfo,
    mediaAccess
  } = useStudio()
  const [pending, setPending] = useState<'camera' | 'microphone' | null>(null)

  // enableMedia awaits across renders (backend restart → reconnect), so it
  // reads live state through refs — closure values would be stale by then.
  const wsStatusRef = useRef(wsStatus)
  const canSampleAudioRef = useRef(canSampleAudio)
  useEffect(() => {
    wsStatusRef.current = wsStatus
    canSampleAudioRef.current = canSampleAudio
  }, [canSampleAudio, wsStatus])

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
  const allGranted = rows.every((row) => row.state === 'granted')
  const isWindows = isWindowsPlatform(runtimeInfo?.platform)
  const deviceNoun = isWindows ? 'PC' : 'Mac'
  const settingsName = osSettingsName(runtimeInfo?.platform)

  // Camera/microphone support a native in-place prompt on first use. The mic
  // chip derives from the audio-meter probe, so a fresh grant is proven by
  // sampling — user-initiated here, never run by the gate itself. When the
  // grant transitioned, main restarted the backend: wait for the reconnect
  // before sampling (FX1 — sampling mid-restart left the chip stuck).
  const enableMedia = async (pane: 'camera' | 'microphone'): Promise<void> => {
    setPending(pane)
    try {
      const result = await window.videorc?.requestMediaAccess?.(pane)
      if (result?.granted) {
        if (result.restarted) {
          await waitFor(() => wsStatusRef.current === 'connected')
        }
        if (pane === 'microphone') {
          await waitFor(() => canSampleAudioRef.current)
          if (canSampleAudioRef.current) {
            await sampleAudioMeter()
          }
        }
      }
      await refreshBackend()
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
              isWindows={isWindows}
              pending={pending === row.id}
              row={row}
              onEnable={() => void enableMedia(row.id as 'camera' | 'microphone')}
              onOpenSettings={() => void openSystemPermission(row.id)}
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
            {allGranted ? 'Continue' : 'Continue without granting'}
            <ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Bounded poll (~10s) — resolves early when the condition holds; on timeout
// the caller just proceeds and the honest derived state stays visible.
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function PermissionRow({
  row,
  isWindows,
  pending,
  onEnable,
  onOpenSettings
}: {
  row: SystemAccessRow
  isWindows: boolean
  pending: boolean
  onEnable: () => void
  onOpenSettings: () => void
}): ReactElement {
  // Screen Recording has no native prompt API — System Settings is the only
  // door. Camera/mic get the in-place prompt while undetermined; once macOS
  // has said no, only System Settings can flip it (TCC never re-asks).
  //
  // Windows has NO in-place prompt at all (askForMediaAccess is macOS-only), so
  // an "Enable" button there was a dead no-op (the tester's "clicking Enable
  // does nothing") — every row opens Settings instead.
  const canEnableInPlace = !isWindows && row.id !== 'screen-recording' && row.state === 'first-use'
  const action =
    row.state === 'granted' || row.state === 'device-issue' ? null : canEnableInPlace ? (
      <Button disabled={pending} size="xs" variant="outline" onClick={onEnable}>
        {pending ? <CircleNotch className="animate-spin" data-icon="inline-start" /> : null}
        Enable
      </Button>
    ) : (
      <Button size="xs" variant="outline" onClick={onOpenSettings}>
        Open settings
      </Button>
    )

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
      {action}
    </div>
  )
}
