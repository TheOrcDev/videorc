import { CheckIcon, CloseIcon, ImageIcon, RefreshIcon } from '@/components/icons'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DisabledReason } from '@/components/ui/disabled-reason'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import type { BuddyLookController, BuddyLookState } from '@/hooks/use-buddy-look'
import type { CohostAvatarPhase, CohostAvatarState } from '@/lib/backend'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { buddyRedoLabel } from '@/lib/buddy-create-gate'
import { buddyLookDraftImages, isBuddyLookRedoState } from '@/lib/buddy-look-view'
import { formatTimecode } from '@/lib/format-time'
import { MediaCard } from '@/components/media-card'
import { cn } from '@/lib/utils'
import { buddyAssetUrl } from '../../../shared/buddy-assets'

/** What the tiles say; the look panel keeps plan 169's words, the onboarding the shared copy. */
export interface BuddyPoseTilesCopy {
  labels: Readonly<Record<CohostAvatarState, string>>
  redo: string
  /** A working tile's line; null shows the skeleton alone (a done pose gets a check). */
  working: ((state: CohostAvatarState, phase: CohostAvatarPhase | undefined) => string) | null
  /** A redoing tile's line; null shows the skeleton alone. */
  redrawing: string | null
  /** The line under a pose that did not come out, from the backend's reason. */
  failed: (reason: string) => string
}

export type BuddyPoseTilesView = 'working' | 'draft' | 'empty'

/**
 * The four poses of a look being made (plan 169 D13, plan 170 D14 step 4):
 * skeletons while it is drawn (idle first, the others from it), the draft's
 * pictures with Redo on talk, laugh and think (R on a focused tile), or four
 * empty slots before anything is made.
 */
export function BuddyPoseTiles({
  view,
  state,
  controller,
  busy,
  redoAllowed,
  redoReason = null,
  imagesLeft = null,
  copy,
  className
}: {
  view: BuddyPoseTilesView
  state: BuddyLookState
  controller: BuddyLookController | null
  busy: boolean
  redoAllowed: boolean
  /** Why Redo is off for the account (plan 174 G-5), shown on the button; null while it works. */
  redoReason?: string | null
  /** "12 images left today" under a draft's tiles (plan 174 G-14); null when the web said nothing. */
  imagesLeft?: string | null
  copy: BuddyPoseTilesCopy
  className?: string
}): ReactElement {
  const draftImages = state.draft ? buddyLookDraftImages(state.draft, state.revision) : null
  const grid = (
    <div
      className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4', className)}
      data-testid="buddy-look-tiles"
    >
      {COHOST_AVATAR_STATES.map((avatarState) => {
        const label = copy.labels[avatarState]
        if (view === 'working') {
          const phase = state.phases[avatarState]
          return (
            <BuddyPoseTile
              key={avatarState}
              done={phase === 'done'}
              label={label}
              state={avatarState}
              status={copy.working?.(avatarState, phase)}
              working
            />
          )
        }
        if (view === 'draft' && draftImages) {
          const path = draftImages[avatarState]
          const redoing = state.running?.kind === 'redo' && state.running.state === avatarState
          const reason =
            state.stateErrors[avatarState] ??
            (path ? undefined : state.draft?.failed[avatarState]?.message)
          const canRedo = isBuddyLookRedoState(avatarState)
          return (
            <BuddyPoseTile
              key={avatarState}
              error={redoing || reason === undefined ? undefined : copy.failed(reason)}
              label={label}
              redo={
                canRedo && controller
                  ? {
                      label: buddyRedoLabel(copy.redo),
                      disabled: busy || !redoAllowed,
                      reason: redoAllowed ? null : redoReason,
                      run: () => {
                        if (isBuddyLookRedoState(avatarState)) void controller.redo(avatarState)
                      }
                    }
                  : undefined
              }
              state={avatarState}
              status={redoing ? (copy.redrawing ?? undefined) : undefined}
              url={path ? buddyAssetUrl(path) : null}
              working={redoing}
            />
          )
        }
        return <BuddyPoseTile key={avatarState} label={label} state={avatarState} />
      })}
    </div>
  )
  if (view !== 'draft' || !imagesLeft) return grid
  return (
    <div className="flex flex-col gap-2">
      {grid}
      <p
        className="text-xs text-muted-foreground tabular-nums"
        data-testid="buddy-look-images-left"
      >
        {imagesLeft}
      </p>
    </div>
  )
}

/** Seconds since `startedAt`, ticking once a second; null when nothing runs. */
function useElapsedMs(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const tick = (): void => setNow(Date.now())
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? null : Math.max(0, now - startedAt)
}

/**
 * The one line under the tiles while a look is drawn (plan 174 G-14): the
 * copy's sentence, how long it has been going, and Cancel while the backend
 * can still drop the result. `line` carries the test id alone, so the clock
 * beside it never changes what the line says.
 */
export function BuddyLookWorkingLine({
  line,
  startedAt,
  cancelling = false,
  onCancel,
  testId
}: {
  line: string
  startedAt: number | null
  cancelling?: boolean
  /** Absent while nothing can be cancelled (a redo gives up through Delete). */
  onCancel?: () => void
  testId?: string
}): ReactElement {
  const elapsed = useElapsedMs(startedAt)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        data-testid={testId}
        role="status"
      >
        <Spinner aria-hidden className="size-4" />
        {line}
      </p>
      {elapsed !== null ? (
        <span
          className="text-xs text-muted-foreground tabular-nums"
          data-testid="buddy-look-elapsed"
        >
          {formatTimecode(elapsed)}
        </span>
      ) : null}
      {onCancel ? (
        <Button
          data-testid="buddy-look-cancel"
          disabled={cancelling}
          size="xs"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <CloseIcon data-icon="inline-start" />
          {cancelling ? 'Canceling…' : 'Cancel'}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * One pose. Its own size container, because its width follows its column
 * (about 110 to 350 px): the R chip shows only where it fits beside Redo,
 * and only while the tile has the focus.
 */
export function BuddyPoseTile({
  state,
  label,
  url = null,
  badge,
  status,
  error,
  working = false,
  done = false,
  redo
}: {
  state: CohostAvatarState
  label: string
  url?: string | null
  badge?: string
  status?: string
  error?: string
  working?: boolean
  /** A working tile whose pose is drawn (the set arrives whole). */
  done?: boolean
  /** Redo, what it costs on its label, and why it is off when it is (the account's reason). */
  redo?: { label: string; disabled: boolean; reason?: string | null; run: () => void }
}): ReactNode {
  return (
    <MediaCard
      className="group/buddy-tile @container/buddy-tile gap-2 p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-done={done || undefined}
      data-state={state}
      data-testid="buddy-look-tile"
      tabIndex={redo ? 0 : undefined}
      onKeyDown={(event) => {
        if (!redo || redo.disabled || event.metaKey || event.ctrlKey || event.altKey) return
        if (event.target !== event.currentTarget) return
        if (event.key === 'r' || event.key === 'R') {
          event.preventDefault()
          redo.run()
        }
      }}
    >
      <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {badge ? <Badge variant="outline">{badge}</Badge> : null}
        {working && done ? (
          <CheckIcon aria-hidden className="size-3.5 text-muted-foreground" weight="bold" />
        ) : null}
      </div>
      {working ? (
        <Skeleton
          className={cn('aspect-square w-full rounded-chip', done && 'animate-none')}
          data-testid="buddy-look-skeleton"
        />
      ) : url ? (
        <div className="aspect-square w-full overflow-hidden rounded-chip bg-muted/30">
          <img
            alt={`${label} picture`}
            className="size-full object-contain"
            decoding="async"
            draggable={false}
            src={url}
          />
        </div>
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-chip bg-muted/30">
          <ImageIcon aria-hidden className="size-5 text-subtle" />
        </div>
      )}
      {status ? (
        <p className="text-xs text-muted-foreground" role="status">
          {status}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-muted-foreground" data-testid="buddy-look-tile-error">
          {error}
        </p>
      ) : null}
      {redo ? (
        <DisabledReason className="w-full" reason={redo.disabled && !working ? redo.reason : null}>
          <Button
            className="w-full"
            data-testid="buddy-look-redo"
            disabled={redo.disabled || working}
            size="xs"
            type="button"
            variant="ghost"
            onClick={redo.run}
          >
            <RefreshIcon data-icon="inline-start" />
            {redo.label}
            {redo.disabled || working ? null : (
              <Kbd className="ml-0.5 hidden @min-[7.5rem]/buddy-tile:group-focus/buddy-tile:inline-flex">
                R
              </Kbd>
            )}
          </Button>
        </DisabledReason>
      ) : null}
    </MediaCard>
  )
}
