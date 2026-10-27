import { createContext, useContext, type ReactElement, type ReactNode, type Ref } from 'react'

import { ArrowLeftIcon, ArrowRightIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { DIALOG_SIZE_CLASS, DIALOG_SURFACE_CLASS, DialogBody } from '@/components/ui/dialog'
import type { FirstRunSetupMode, FirstRunStep } from '@/lib/first-run'
import { cn } from '@/lib/utils'

export const FIRST_RUN_TITLE_ID = 'first-run-title'

/** Each step's title, the window's `h1` while it shows (plan 207 D12). */
export const FIRST_RUN_STEP_TITLES: Readonly<Record<FirstRunStep, string>> = {
  permissions: 'Welcome to Videorc',
  goal: 'What are you making?',
  look: 'Your look',
  sound: 'Sound check',
  destinations: 'Where you stream'
}

/** The dialog widths a step may take: `xl` for the one media step (plan 207 D6). */
export type FirstRunCardSize = 'lg' | 'xl'

/** What the frame hands every step: where it is, and the ways out of it. */
export interface FirstRunStepFrame {
  step: FirstRunStep
  position: { index: number; count: number }
  /** The fade-out is running: every button is spent. */
  leaving: boolean
  /** The previous step, or null on the first one. */
  back: (() => void) | null
  /** Moves on, or leaves setup from the last step. */
  next: () => void
  /** "Continue", or on the last step "Open Studio" ("Done" in a replay). */
  nextLabel: string
  /** Leaves setup at once, keeping what was chosen (D3). */
  skip: () => void
  /** Goes straight to an earlier step that applies here ("Back to permissions"). */
  goTo: (step: FirstRunStep) => void
}

const FrameContext = createContext<FirstRunStepFrame | null>(null)

export const FirstRunStepFrameProvider = FrameContext.Provider

export function useFirstRunStepFrame(): FirstRunStepFrame {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error('A first-run step renders inside FirstRunSetup.')
  return frame
}

/**
 * The one card (plan 203 D1, plan 207 S3): the dialog tier at the step's
 * width, the window's `main` landmark. It stays mounted from step to step so
 * its width eases between `lg` and `xl` while the step inside cross-fades.
 */
export function FirstRunCard({
  step,
  mode,
  size,
  position,
  cardRef,
  children
}: {
  step: FirstRunStep
  mode: FirstRunSetupMode
  size: FirstRunCardSize
  position: { index: number; count: number }
  cardRef?: Ref<HTMLElement>
  children: ReactNode
}): ReactElement {
  return (
    <main
      ref={cardRef}
      aria-labelledby={FIRST_RUN_TITLE_ID}
      className={cn(
        DIALOG_SURFACE_CLASS,
        DIALOG_SIZE_CLASS[size],
        'flex max-h-full w-full flex-col transition-[max-width] duration-150 ease-out motion-reduce:transition-none'
      )}
      data-first-run-mode={mode.kind}
      data-first-run-step={step}
      data-first-run-step-position={`${position.index}/${position.count}`}
      data-slot="first-run-card"
    >
      {/* A step change is announced once, with where it sits. */}
      <p aria-live="polite" className="sr-only">
        {`Step ${position.index} of ${position.count}, ${FIRST_RUN_STEP_TITLES[step]}`}
      </p>
      {children}
    </main>
  )
}

/**
 * One step's anatomy inside the card: the step count and "Skip setup" on the
 * top line, the title and description (with an optional lead, the app icon
 * on Permissions), the body that scrolls, an optional footnote, and the
 * footer with Back at the left and the step's one primary at the right.
 */
export function FirstRunStepLayout({
  lead,
  description,
  footnote,
  primary,
  children
}: {
  lead?: ReactNode
  description: ReactNode
  footnote?: ReactNode
  /** The step's one primary; null when the body is the action (the goal rows). */
  primary: ReactNode
  children: ReactNode
}): ReactElement {
  const frame = useFirstRunStepFrame()
  return (
    <div
      className="flex min-h-0 flex-1 animate-in flex-col gap-5 duration-150 fade-in-0 motion-reduce:animate-none"
      data-first-run-step-body={frame.step}
    >
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-meta text-muted-foreground">
            {`Step ${frame.position.index} of ${frame.position.count}`}
          </p>
          <Button
            data-first-run-skip=""
            disabled={frame.leaving}
            variant="ghost"
            onClick={frame.skip}
          >
            Skip setup
          </Button>
        </div>
        <div className="flex items-center gap-4">
          {lead}
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="font-heading text-base leading-none font-medium" id={FIRST_RUN_TITLE_ID}>
              {FIRST_RUN_STEP_TITLES[frame.step]}
            </h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
      </div>

      <DialogBody>{children}</DialogBody>

      <div className="flex shrink-0 flex-col gap-3">
        {footnote}
        <div className="flex items-center gap-2">
          {frame.back ? (
            <Button
              data-first-run-back=""
              disabled={frame.leaving}
              variant="ghost"
              onClick={frame.back}
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">{primary}</div>
        </div>
      </div>
    </div>
  )
}

/** The usual primary: Continue, or the last step's way out, with the arrow. */
export function FirstRunNextButton({ disabled = false }: { disabled?: boolean }): ReactElement {
  const frame = useFirstRunStepFrame()
  return (
    <Button data-first-run-primary="" disabled={disabled || frame.leaving} onClick={frame.next}>
      {frame.nextLabel}
      <ArrowRightIcon data-icon="inline-end" />
    </Button>
  )
}
