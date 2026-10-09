import { CheckIcon, ImageIcon, RefreshIcon } from '@/components/icons'
import type { ReactElement, ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { Skeleton } from '@/components/ui/skeleton'
import type { GolemLookController, GolemLookState } from '@/hooks/use-golem-look'
import type { CohostAvatarPhase, CohostAvatarState } from '@/lib/backend'
import { COHOST_AVATAR_STATES } from '@/lib/backend'
import { golemLookDraftImages, isGolemLookRedoState } from '@/lib/golem-look-view'
import { cn } from '@/lib/utils'
import { golemAssetUrl } from '../../../shared/golem-assets'

/** What the tiles say; the look panel keeps plan 169's words, the onboarding the shared copy. */
export interface GolemPoseTilesCopy {
  labels: Readonly<Record<CohostAvatarState, string>>
  redo: string
  /** A working tile's line; null shows the skeleton alone (a done pose gets a check). */
  working: ((state: CohostAvatarState, phase: CohostAvatarPhase | undefined) => string) | null
  /** A redoing tile's line; null shows the skeleton alone. */
  redrawing: string | null
  /** The line under a pose that did not come out, from the backend's reason. */
  failed: (reason: string) => string
}

export type GolemPoseTilesView = 'working' | 'draft' | 'empty'

/**
 * The four poses of a look being made (plan 169 D13, plan 170 D14 step 4):
 * skeletons while it is drawn (idle first, the others from it), the draft's
 * pictures with Redo on talk, laugh and think (R on a focused tile), or four
 * empty slots before anything is made.
 */
export function GolemPoseTiles({
  view,
  state,
  controller,
  busy,
  redoAllowed,
  copy,
  className
}: {
  view: GolemPoseTilesView
  state: GolemLookState
  controller: GolemLookController | null
  busy: boolean
  redoAllowed: boolean
  copy: GolemPoseTilesCopy
  className?: string
}): ReactElement {
  const draftImages = state.draft ? golemLookDraftImages(state.draft, state.revision) : null
  return (
    <div
      className={cn('grid grid-cols-2 gap-3 sm:grid-cols-4', className)}
      data-testid="golem-look-tiles"
    >
      {COHOST_AVATAR_STATES.map((avatarState) => {
        const label = copy.labels[avatarState]
        if (view === 'working') {
          const phase = state.phases[avatarState]
          return (
            <GolemPoseTile
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
          const canRedo = isGolemLookRedoState(avatarState)
          return (
            <GolemPoseTile
              key={avatarState}
              error={redoing || reason === undefined ? undefined : copy.failed(reason)}
              label={label}
              redo={
                canRedo && controller
                  ? {
                      label: copy.redo,
                      disabled: busy || !redoAllowed,
                      run: () => {
                        if (isGolemLookRedoState(avatarState)) void controller.redo(avatarState)
                      }
                    }
                  : undefined
              }
              state={avatarState}
              status={redoing ? (copy.redrawing ?? undefined) : undefined}
              url={path ? golemAssetUrl(path) : null}
              working={redoing}
            />
          )
        }
        return <GolemPoseTile key={avatarState} label={label} state={avatarState} />
      })}
    </div>
  )
}

/**
 * One pose. Its own size container, because its width follows its column
 * (about 110 to 350 px): the R chip shows only where it fits beside Redo,
 * and only while the tile has the focus.
 */
export function GolemPoseTile({
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
  redo?: { label: string; disabled: boolean; run: () => void }
}): ReactNode {
  return (
    <div
      className="group/golem-tile @container/golem-tile flex flex-col gap-2 rounded-row border border-border bg-muted/20 p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-done={done || undefined}
      data-state={state}
      data-testid="golem-look-tile"
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
          data-testid="golem-look-skeleton"
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
        <p className="text-xs text-subtle" data-testid="golem-look-tile-error">
          {error}
        </p>
      ) : null}
      {redo ? (
        <Button
          className="w-full"
          data-testid="golem-look-redo"
          disabled={redo.disabled || working}
          size="xs"
          type="button"
          variant="ghost"
          onClick={redo.run}
        >
          <RefreshIcon data-icon="inline-start" />
          {redo.label}
          {redo.disabled || working ? null : (
            <Kbd className="ml-0.5 hidden @min-[7.5rem]/golem-tile:group-focus/golem-tile:inline-flex">
              R
            </Kbd>
          )}
        </Button>
      ) : null}
    </div>
  )
}
