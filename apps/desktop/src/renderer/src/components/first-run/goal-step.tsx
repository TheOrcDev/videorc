import type { KeyboardEvent, ReactElement } from 'react'

import { FirstRunStepLayout, useFirstRunStepFrame } from '@/components/first-run/setup-step-frame'
import {
  CheckIcon,
  ChevronRightIcon,
  LivestreamIcon,
  RecordIcon,
  StudioIcon,
  type AppIcon
} from '@/components/icons'
import { GroupedList } from '@/components/list-row'
import { useStudioCore } from '@/hooks/use-studio'
import type { FirstRunGoal } from '@/lib/first-run'
import { platformCopy } from '@/lib/platform-copy'
import { cn } from '@/lib/utils'

interface GoalChoice {
  goal: FirstRunGoal
  title: string
  line: string
  Icon: AppIcon
}

function goalChoices(deviceNoun: string): GoalChoice[] {
  return [
    {
      goal: 'record',
      title: 'Recordings',
      line: `Tutorials, demos and videos, saved on this ${deviceNoun}.`,
      Icon: RecordIcon
    },
    {
      goal: 'stream',
      title: 'Livestreams',
      line: 'Go live on YouTube, Twitch, Kick or X.',
      Icon: LivestreamIcon
    },
    { goal: 'both', title: 'Both', line: 'Record and go live.', Icon: StudioIcon }
  ]
}

/** Up and Down move between the choices, as in a menu. */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[data-first-run-goal]')
  )
  const index = rows.indexOf(document.activeElement as HTMLElement)
  if (index < 0) return
  event.preventDefault()
  const step = event.key === 'ArrowDown' ? 1 : -1
  rows[(index + step + rows.length) % rows.length]?.focus()
}

/**
 * Step 2, "What are you making?" (plan 207 D4): three choices, nothing picked
 * on a first run. A click (or Enter) picks one and moves on, so the rows are
 * the step's action and the footer has no primary. The choice only decides
 * whether "Where you stream" follows; nothing in the Studio changes.
 */
export function GoalStep({
  goal,
  onPick
}: {
  /** The saved choice, marked in a replay or after Back. */
  goal: FirstRunGoal | null
  onPick: (goal: FirstRunGoal) => void
}): ReactElement {
  const { runtimeInfo } = useStudioCore()
  const frame = useFirstRunStepFrame()
  const { deviceNoun } = platformCopy(runtimeInfo?.platform)
  const choices = goalChoices(deviceNoun)
  const focusGoal = goal ?? choices[0].goal
  return (
    <FirstRunStepLayout
      description="Pick what you'll do most. It only changes the next steps."
      primary={null}
    >
      <GroupedList aria-label="What are you making?" onKeyDown={moveFocus}>
        {choices.map(({ goal: value, title, line, Icon }) => {
          const chosen = value === goal
          return (
            <button
              key={value}
              className={cn(
                'flex w-full cursor-default items-center gap-3 px-3 py-2.5 text-left outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-50',
                chosen && 'bg-accent'
              )}
              data-first-run-autofocus={value === focusGoal ? '' : undefined}
              data-first-run-goal={value}
              data-selected={chosen || undefined}
              disabled={frame.leaving}
              type="button"
              onClick={() => onPick(value)}
            >
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">{title}</span>
                <span className="text-meta text-muted-foreground">{line}</span>
              </span>
              {chosen ? (
                <>
                  <CheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="sr-only">Chosen</span>
                </>
              ) : (
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
            </button>
          )
        })}
      </GroupedList>
    </FirstRunStepLayout>
  )
}
