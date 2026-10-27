import { useEffect, useState, type ReactElement } from 'react'

import { PermissionsStep } from '@/components/first-run/permissions-step'
import { WelcomeBackdrop } from '@/components/first-run/welcome-backdrop'
import { useTrafficLightGutter } from '@/components/window-frame'
import { useStudioCore } from '@/hooks/use-studio'
import { StudioMicVisualProvider } from '@/hooks/use-studio-mic-visual'
import type {
  FirstRunCompletion,
  FirstRunGoal,
  FirstRunSetupMode,
  FirstRunStep
} from '@/lib/first-run'
import { cn } from '@/lib/utils'

/** The fade of the card and the backdrop on Continue or Skip for now (the skill's motion scale). */
export const FIRST_RUN_LEAVE_MS = 150

/**
 * First-run setup (plan 203, owner call D1): the whole main window while it
 * is open, in place of the sidebar and the page. The Liquid Chrome backdrop
 * fills the window under a 40 px title band that keeps the traffic lights and
 * the drag region, and the current step sits in one card in the middle.
 * Continue or Skip for now fade it out, then the shell shows the Studio (the
 * first launch) or the page setup was opened from (a replay).
 */
export function FirstRunSetup({
  mode,
  onLeave
}: {
  mode: FirstRunSetupMode
  /** Saved progress for the multi-step frame (plan 207 S3). */
  initialStep?: FirstRunStep
  initialGoal?: FirstRunGoal | null
  onEnterStep?: (step: FirstRunStep) => void
  onGoalChange?: (goal: FirstRunGoal) => void
  /** After the fade: write the record (first run) or return (replay). */
  onLeave: (completion: FirstRunCompletion) => void
}): ReactElement {
  const { runtimeInfo, refreshBackend } = useStudioCore()
  const trafficLightGutter = useTrafficLightGutter()
  const [leaving, setLeaving] = useState<FirstRunCompletion | null>(null)

  // Grants flip in System Settings or the native prompt while Videorc is in
  // the background: re-read them on focus so the chips stay honest.
  useEffect(() => {
    const onFocus = (): void => {
      void (async () => {
        await window.videorc?.recheckPermissionGrants?.()
        await refreshBackend()
      })()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshBackend])

  useEffect(() => {
    if (leaving === null) return
    const timer = window.setTimeout(() => onLeave(leaving), FIRST_RUN_LEAVE_MS)
    return () => window.clearTimeout(timer)
  }, [leaving, onLeave])

  return (
    <div
      className={cn(
        'relative flex h-screen flex-col overflow-hidden text-foreground transition-opacity duration-150 ease-out motion-reduce:transition-none',
        leaving !== null && 'opacity-0'
      )}
      data-first-run-setup={leaving === null ? 'open' : 'leaving'}
      data-first-run-mode={mode.kind}
    >
      <WelcomeBackdrop hardwareAccelerationDisabled={runtimeInfo?.hardwareAccelerationDisabled} />
      {/* The window family's title band: the traffic lights' line and the
          drag region, with nothing on it. */}
      <header
        className={cn(
          'relative h-toolbar shrink-0 select-none [-webkit-app-region:drag]',
          trafficLightGutter
        )}
        data-slot="first-run-title-band"
      />
      <div className="relative flex min-h-0 flex-1 items-center justify-center p-4">
        {/* The Microphone row's level needs the workspace's visual pipeline,
            which only opens a granted, selected microphone. */}
        <StudioMicVisualProvider enabled>
          <PermissionsStep leaving={leaving !== null} mode={mode} onLeave={setLeaving} />
        </StudioMicVisualProvider>
      </div>
    </div>
  )
}
