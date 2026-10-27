import { ArrowRightIcon } from '@/components/icons'
import { useEffect, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { SystemAccessList } from '@/components/system-access-list'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useStudioAudio, useStudioCore } from '@/hooks/use-studio'
import { platformCopy } from '@/lib/platform-copy'
import { systemAccessRows } from '@/lib/system-access'
import type { FirstRunCompletion } from '@/lib/first-run'

// Permissions-only onboarding: the ONE thing a fresh install needs is the
// OS's grants, so this is the whole flow. Its rows are Settings →
// Permissions' own list (SystemAccessList, plan 174 S3.17), on the same state
// derivation (system-access.ts, never guessed), with the grant action each
// permission actually supports. On Windows a row's detail names the
// desktop-apps switch while it is off. Every fresh install sees this step,
// even when all grants are already present (see app-shell's gate).
export function PermissionsOnboardingDialog({
  open,
  onComplete
}: {
  open: boolean
  onComplete: (status: FirstRunCompletion) => void
}): ReactElement {
  const { deviceList, refreshBackend, handleSystemPermission, runtimeInfo, mediaAccess } =
    useStudioCore()
  const { audioMeter } = useStudioAudio()

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

  const platform = runtimeInfo?.platform
  const rows = systemAccessRows({ deviceList, audioMeter, platform, mediaAccess })
  // Plan 174 I-9: "capture your Mac" was said on Linux too.
  const { deviceNoun, osName, osSettingsName: settingsName } = platformCopy(platform)

  return (
    <Dialog open={open}>
      <DialogContent
        size="lg"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-3">
            {/* Decorative: the title beside it already names Videorc (A-16). */}
            <img alt="" className="size-14 object-contain" src={logoUrl} />
            <div className="flex flex-col gap-1">
              <DialogTitle>Let Videorc capture your {deviceNoun}</DialogTitle>
              <DialogDescription>
                {osName === 'Windows'
                  ? `Turn on camera and microphone access in ${settingsName}. You can change any of this later in Settings → Permissions.`
                  : osName === 'macOS'
                    ? 'macOS asks once per permission. Grant what you need. You can change any of this later in Settings → Permissions.'
                    : 'Grant what you need. You can change any of this later in Settings → Permissions.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogBody>
          <SystemAccessList
            mediaAccess={mediaAccess}
            platform={platform}
            rows={rows}
            onAction={handleSystemPermission}
          />
        </DialogBody>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            Recordings stay on this {deviceNoun}. Cloud AI only runs after you opt in.
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" onClick={() => onComplete('skipped')}>
              Skip for now
            </Button>
            <Button onClick={() => onComplete('done')}>
              Continue
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
