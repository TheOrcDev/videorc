import { lazy, Suspense, type ReactElement } from 'react'

import type { GolemPetPreviewProps } from '@/components/golem-pet-preview'
import { cn } from '@/lib/utils'

// The living preview is its own chunk (plan 168 S-D1): canvas, player and
// motion model load the first time a Golem surface shows it, never with the
// app shell.
const GolemPetPreviewChunk = lazy(() => import('@/components/golem-pet-preview'))

/**
 * `GolemPetPreview`, loaded on demand. Until the chunk arrives the box
 * shows `placeholder` at the same size, so nothing around it moves.
 */
export function LazyGolemPetPreview(props: GolemPetPreviewProps): ReactElement {
  return (
    <Suspense
      fallback={
        <div
          className={cn('relative flex shrink-0 items-center justify-center', props.className)}
          data-status="loading"
          data-testid="golem-pet-preview"
          style={{ width: props.size, height: props.size }}
        >
          {props.placeholder}
        </div>
      }
    >
      <GolemPetPreviewChunk {...props} />
    </Suspense>
  )
}
