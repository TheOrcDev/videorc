import { ArrowRightIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { GroupedList } from '@/components/list-row'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SystemAccessList } from '@/components/system-access-list'
import { Button } from '@/components/ui/button'
import { DIALOG_SIZE_CLASS, DIALOG_SURFACE_CLASS, DialogBody } from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import { useSystemAccessRows } from '@/hooks/use-system-access-rows'
import type { FirstRunCompletion, FirstRunSetupMode } from '@/lib/first-run'
import { platformCopy } from '@/lib/platform-copy'
import { isMediaAccessSnapshotReady } from '@/lib/system-access'
import {
  FIRST_RUN_ROWS_FALLBACK_MS,
  firstRunPrimary,
  firstRunSetupDescription,
  systemAccessRowsReady
} from '@/lib/system-access-view'
import { cn } from '@/lib/utils'

const SKELETON_ROWS = 4
export const FIRST_RUN_TITLE_ID = 'first-run-title'

/** True once `ms` have passed since mount: setup's wait for a slow backend. */
function useWaitedLong(ms: number): boolean {
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), ms)
    return () => window.clearTimeout(timer)
  }, [ms])
  return waited
}

/** The Microphone row's proof (plan 203 D6): the live level, fed as the Studio feeds it. */
function MicrophoneProof(): ReactElement {
  const { meter } = useMicrophoneMeter()
  return (
    <div className="flex flex-col gap-1.5" data-first-run-microphone-proof="">
      <MicLevelMeter aria-label="Microphone level" className="min-w-0" meter={meter} />
      <p className="text-meta text-muted-foreground">
        Say something. The bar moves when Videorc hears you.
      </p>
    </div>
  )
}

/**
 * Step 1 of first-run setup, Permissions (plan 203 S5): the card on the dialog
 * tier at the `lg` dialog width, with the app icon, the title as the window's
 * `h1`, the OS's own description, the four system access rows in their setup
 * variant, the privacy line and one primary that reads Continue once every
 * needed grant is in and Skip for now before (D3). It is the window's `main`
 * landmark and not a dialog: no scrim, no focus trap, and Escape does nothing.
 */
export function PermissionsStep({
  mode,
  onLeave,
  leaving = false
}: {
  mode: FirstRunSetupMode
  /** Continue or Skip for now, with what the first-run record should say. */
  onLeave: (completion: FirstRunCompletion) => void
  /** The fade-out is running: the primary is spent. */
  leaving?: boolean
}): ReactElement {
  const { wsStatus, deviceList, mediaAccess, runtimeInfo, handleSystemPermission } = useStudioCore()
  const platform = runtimeInfo?.platform
  const { deviceNoun, osName } = platformCopy(platform)
  const rows = useSystemAccessRows()
  const waitedLong = useWaitedLong(FIRST_RUN_ROWS_FALLBACK_MS)
  const ready = systemAccessRowsReady({
    mediaAccessReady: isMediaAccessSnapshotReady(mediaAccess),
    devicesListed: wsStatus === 'connected' && deviceList.devices.length > 0,
    waitedLong
  })
  const nothingToGrant = osName === 'Linux'
  const primary = firstRunPrimary(rows)
  const cardRef = useRef<HTMLElement>(null)

  // Focus lands on the first row that has something to press, else on the
  // primary, once the rows are real (never on a Skeleton).
  useEffect(() => {
    if (!ready && !nothingToGrant) return
    const card = cardRef.current
    if (!card || card.contains(document.activeElement)) return
    const target =
      card.querySelector<HTMLElement>('[data-slot="system-access-row"] button') ??
      card.querySelector<HTMLElement>('[data-first-run-primary]')
    target?.focus()
  }, [nothingToGrant, ready])

  return (
    <main
      ref={cardRef}
      aria-labelledby={FIRST_RUN_TITLE_ID}
      className={cn(
        DIALOG_SURFACE_CLASS,
        DIALOG_SIZE_CLASS.lg,
        'flex max-h-full w-full flex-col gap-5'
      )}
      data-first-run-step="permissions"
      data-first-run-mode={mode.kind}
      data-slot="first-run-card"
    >
      <div className="flex shrink-0 items-center gap-4">
        {/* Decorative: the title beside it names Videorc. */}
        <img alt="" className="size-16 shrink-0 object-contain" draggable={false} src={logoUrl} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="font-heading text-base leading-none font-medium" id={FIRST_RUN_TITLE_ID}>
            Welcome to Videorc
          </h1>
          <p className="text-sm text-muted-foreground">{firstRunSetupDescription(platform)}</p>
        </div>
      </div>

      <DialogBody>
        {nothingToGrant ? (
          // Linux (plan 174 I-8): no standing grants; the desktop portal asks
          // per capture. The same words as Settings → Permissions.
          <Empty className="p-4" data-testid="system-access-none">
            <EmptyHeader>
              <EmptyTitle>Nothing to grant here</EmptyTitle>
              <EmptyDescription>
                Linux keeps no capture permissions for apps. Your desktop may ask when Videorc
                starts capturing the screen.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : ready ? (
          <SystemAccessList
            mediaAccess={mediaAccess}
            microphoneProof={<MicrophoneProof />}
            platform={platform}
            rows={rows}
            variant="setup"
            onAction={handleSystemPermission}
          />
        ) : (
          <GroupedList aria-busy aria-label="System access" data-first-run-rows="loading">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <div key={index} className="flex flex-col gap-2 px-3 py-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            ))}
            <span className="sr-only" role="status">
              Checking permissions…
            </span>
          </GroupedList>
        )}
      </DialogBody>

      <div className="flex shrink-0 flex-col gap-3">
        <p className="text-meta text-muted-foreground">
          Recordings stay on this {deviceNoun}. Cloud AI only runs after you opt in.
        </p>
        <div className="flex justify-end">
          <Button
            data-first-run-primary=""
            disabled={leaving}
            variant={primary.label === 'Continue' ? 'default' : 'outline'}
            onClick={() => onLeave(primary.completion)}
          >
            {primary.label}
            {primary.label === 'Continue' ? <ArrowRightIcon data-icon="inline-end" /> : null}
          </Button>
        </div>
      </div>
    </main>
  )
}
