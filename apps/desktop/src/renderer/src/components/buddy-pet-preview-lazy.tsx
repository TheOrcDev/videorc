import { lazy, Suspense, type ReactElement } from 'react'

import type { BuddyPetPreviewProps } from '@/components/buddy-pet-preview'
import { cn } from '@/lib/utils'

// The living preview is its own chunk (plan 168 S-D1): canvas, player and
// motion model load the first time a Golem surface shows it, never with the
// app shell.
const BuddyPetPreviewChunk = lazy(() => import('@/components/buddy-pet-preview'))

/**
 * `BuddyPetPreview`, loaded on demand. Until the chunk arrives the box
 * shows `placeholder` at the same size, so nothing around it moves.
 */
export function LazyBuddyPetPreview(props: BuddyPetPreviewProps): ReactElement {
  return (
    <Suspense
      fallback={
        <div
          className={cn('relative flex shrink-0 items-center justify-center', props.className)}
          data-status="loading"
          data-testid="buddy-pet-preview"
          style={{ width: props.size, height: props.size }}
        >
          {props.placeholder}
        </div>
      }
    >
      <BuddyPetPreviewChunk {...props} />
    </Suspense>
  )
}
