import { ArrowRightIcon } from '@/components/icons'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import logoUrl from '@/assets/videorc-logo.png'
import { GroupedList } from '@/components/list-row'
import { MicLevelMeter } from '@/components/studio/mic-level-meter'
import { SystemAccessList } from '@/components/system-access-list'
import { FirstRunStepLayout, useFirstRunStepFrame } from '@/components/first-run/setup-step-frame'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Skeleton } from '@/components/ui/skeleton'
import { useStudioCore } from '@/hooks/use-studio'
import { useMicrophoneMeter } from '@/hooks/use-studio-mic-sources'
import { useSystemAccessRows } from '@/hooks/use-system-access-rows'
import { platformCopy } from '@/lib/platform-copy'
import { isMediaAccessSnapshotReady } from '@/lib/system-access'
import {
  FIRST_RUN_ROWS_FALLBACK_MS,
  LINUX_CAPTURE_ACCESS,
  firstRunPrimary,
  firstRunSetupDescription,
  systemAccessRowsReady
} from '@/lib/system-access-view'

const SKELETON_ROWS = 4

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
 * Step 1 of first-run setup, Permissions (plan 203 S5, plan 207 S3): the app
 * icon, the title as the window's `h1`, the OS's own description, the four
 * system access rows in their setup variant, the privacy line and one primary
 * that reads Continue once every needed grant is in and Skip for now before
 * (D3). Both move on to the next step; "Skip setup" leaves setup.
 */
export function PermissionsStep(): ReactElement {
  const { wsStatus, deviceList, mediaAccess, runtimeInfo, handleSystemPermission } = useStudioCore()
  const frame = useFirstRunStepFrame()
  const platform = runtimeInfo?.platform
  const { deviceNoun, osName } = platformCopy(platform)
  const rows = useSystemAccessRows()
  const waitedLong = useWaitedLong(FIRST_RUN_ROWS_FALLBACK_MS)
  const ready = systemAccessRowsReady({
    mediaAccessReady: isMediaAccessSnapshotReady(mediaAccess),
    devicesListed: wsStatus === 'connected' && deviceList.devices.length > 0,
    waitedLong
  })
  const portalGuidance = osName === 'Linux'
  const primaryLabel = portalGuidance ? 'Continue' : firstRunPrimary(rows).label
  const bodyRef = useRef<HTMLDivElement>(null)

  // Focus lands on the first row that has something to press, else on the
  // primary, once the rows are real (never on a Skeleton).
  useEffect(() => {
    if (!ready && !portalGuidance) return
    const card = bodyRef.current?.closest<HTMLElement>('[data-slot="first-run-card"]')
    if (!card || card.contains(document.activeElement)) return
    const target =
      card.querySelector<HTMLElement>('[data-slot="system-access-row"] button') ??
      card.querySelector<HTMLElement>('[data-first-run-primary]')
    target?.focus()
  }, [portalGuidance, ready])

  return (
    <FirstRunStepLayout
      description={firstRunSetupDescription(platform)}
      footnote={
        <p className="text-meta text-muted-foreground">
          Recordings stay on this {deviceNoun}. Cloud AI only runs after you opt in.
        </p>
      }
      lead={
        // Decorative: the title beside it names Videorc.
        <img alt="" className="size-16 shrink-0 object-contain" draggable={false} src={logoUrl} />
      }
      primary={
        <Button
          data-first-run-primary=""
          disabled={frame.leaving}
          variant={primaryLabel === 'Continue' ? 'default' : 'outline'}
          onClick={frame.next}
        >
          {primaryLabel}
          {primaryLabel === 'Continue' ? <ArrowRightIcon data-icon="inline-end" /> : null}
        </Button>
      }
    >
      <div ref={bodyRef}>
        {portalGuidance ? (
          <Empty className="p-4" data-first-run-linux-access="" data-testid="system-access-none">
            <EmptyHeader>
              <EmptyTitle>{LINUX_CAPTURE_ACCESS.title}</EmptyTitle>
              <EmptyDescription>{LINUX_CAPTURE_ACCESS.description}</EmptyDescription>
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
      </div>
    </FirstRunStepLayout>
  )
}
