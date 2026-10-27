import { useEffect, useRef, useState, type ReactElement } from 'react'

import { GoalStep } from '@/components/first-run/goal-step'
import { PermissionsStep } from '@/components/first-run/permissions-step'
import {
  FirstRunCard,
  FirstRunStepFrameProvider,
  type FirstRunCardSize,
  type FirstRunStepFrame
} from '@/components/first-run/setup-step-frame'
import { WelcomeBackdrop } from '@/components/first-run/welcome-backdrop'
import { useTrafficLightGutter } from '@/components/window-frame'
import { useStudioCore } from '@/hooks/use-studio'
import { StudioMicVisualProvider } from '@/hooks/use-studio-mic-visual'
import {
  FIRST_RUN_STEPS,
  firstRunStepsFor,
  type FirstRunGoal,
  type FirstRunLeave,
  type FirstRunSetupMode,
  type FirstRunStep
} from '@/lib/first-run'
import { cn } from '@/lib/utils'

/** The fade of the card and the backdrop on leaving setup (the skill's motion scale). */
export const FIRST_RUN_LEAVE_MS = 150

/** The steps that have a screen, in order. A step without one is passed over. */
const STEP_SIZES: Partial<Record<FirstRunStep, FirstRunCardSize>> = {
  permissions: 'lg',
  goal: 'lg'
}

const stepOrder = (step: FirstRunStep): number => FIRST_RUN_STEPS.indexOf(step)

/**
 * First-run setup (plan 203, owner call D1; plan 207): the whole main window
 * while it is open, in place of the sidebar and the page. The Liquid Chrome
 * backdrop fills the window under a 40 px title band that keeps the traffic
 * lights and the drag region, and the steps take turns in one card in the
 * middle. Every step has "Skip setup"; the last one's primary, or Skip setup,
 * fades it out, then the shell shows the Studio (the first launch) or the page
 * setup was opened from (a replay).
 */
export function FirstRunSetup({
  mode,
  initialStep,
  initialGoal = null,
  onEnterStep,
  onGoalChange,
  onLeave
}: {
  mode: FirstRunSetupMode
  /** Where a first run resumes (plan 207 S1); a replay starts at the top. */
  initialStep?: FirstRunStep
  initialGoal?: FirstRunGoal | null
  onEnterStep?: (step: FirstRunStep) => void
  onGoalChange?: (goal: FirstRunGoal) => void
  /** After the fade: write the record (first run) or return (replay). */
  onLeave: (leave: FirstRunLeave) => void
}): ReactElement {
  const { runtimeInfo, refreshBackend } = useStudioCore()
  const trafficLightGutter = useTrafficLightGutter()
  const [leaving, setLeaving] = useState<FirstRunLeave | null>(null)
  const [savedStep, setSavedStep] = useState<FirstRunStep>(initialStep ?? 'permissions')
  const [goal, setGoal] = useState<FirstRunGoal | null>(initialGoal)
  const cardRef = useRef<HTMLElement>(null)
  const platform = runtimeInfo?.platform

  const stepsFor = (forGoal: FirstRunGoal | null): FirstRunStep[] =>
    firstRunStepsFor({ goal: forGoal, platform, mode }).filter((step) => step in STEP_SIZES)
  const steps = stepsFor(goal)
  // A saved step that doesn't apply here (Permissions on Linux) starts at the
  // next one that does.
  const step =
    steps.find((candidate) => stepOrder(candidate) >= stepOrder(savedStep)) ??
    steps.at(-1) ??
    'permissions'
  const index = steps.indexOf(step)

  const enter = (next: FirstRunStep): void => {
    setSavedStep(next)
    onEnterStep?.(next)
  }
  const nextFrom = (list: FirstRunStep[]): void => {
    const next = list[list.indexOf(step) + 1]
    if (next) enter(next)
    else setLeaving({ completion: 'done' })
  }
  const pickGoal = (picked: FirstRunGoal): void => {
    setGoal(picked)
    onGoalChange?.(picked)
    nextFrom(stepsFor(picked))
  }

  const frame: FirstRunStepFrame = {
    step,
    position: { index: index + 1, count: steps.length },
    leaving: leaving !== null,
    back: index > 0 ? () => enter(steps[index - 1]) : null,
    next: () => nextFrom(steps),
    nextLabel:
      index < steps.length - 1 ? 'Continue' : mode.kind === 'replay' ? 'Done' : 'Open Studio',
    skip: () => setLeaving({ completion: 'skipped' })
  }

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

  // A new step takes the keyboard: its marked control, else its first
  // button, else the primary. The first step places its own focus.
  const shownStep = useRef(step)
  useEffect(() => {
    if (shownStep.current === step) return
    shownStep.current = step
    const card = cardRef.current
    const body = card?.querySelector<HTMLElement>(
      '[data-first-run-step-body] [data-slot="dialog-body"]'
    )
    const target =
      card?.querySelector<HTMLElement>('[data-first-run-autofocus]') ??
      body?.querySelector<HTMLElement>('button:not(:disabled), [role="switch"], input') ??
      card?.querySelector<HTMLElement>('[data-first-run-primary]')
    target?.focus()
  }, [step])

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
          <FirstRunStepFrameProvider value={frame}>
            <FirstRunCard
              cardRef={cardRef}
              mode={mode}
              position={frame.position}
              size={STEP_SIZES[step] ?? 'lg'}
              step={step}
            >
              {step === 'goal' ? (
                <GoalStep key={step} goal={goal} onPick={pickGoal} />
              ) : (
                <PermissionsStep key={step} />
              )}
            </FirstRunCard>
          </FirstRunStepFrameProvider>
        </StudioMicVisualProvider>
      </div>
    </div>
  )
}
