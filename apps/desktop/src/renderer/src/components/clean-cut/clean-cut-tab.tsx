import { lazy, Suspense, useLayoutEffect, type ReactElement } from 'react'

import { CleanCutCard, type CleanCutFocus } from '@/components/clean-cut/clean-cut-card'
import type { CleanCutClient } from '@/hooks/use-clean-cut'
import {
  applyCleanCutRequest,
  cleanCutReviewTargetOf,
  closeCleanCutReview,
  openCleanCutReview,
  pendingCleanCutRequest,
  useOpenCleanCutReview
} from '@/lib/clean-cut-drafts'
import type { CleanCutTabRequest } from '@/lib/clean-cut-events'

// The review is the heaviest part of Clean cut (player, transcript editor):
// it loads the first time a cut is reviewed.
const CleanCutReview = lazy(async () => ({
  default: (await import('@/components/clean-cut/clean-cut-review')).CleanCutReview
}))

/**
 * The Buddy page's Clean cut tab (plan 119 S14; plan 174 S3.13, D6): the
 * recordings and their cuts, or one cut's review. The open review lives
 * outside the page (`lib/clean-cut-drafts.ts`), so a tab or page switch comes
 * back to it with its unsaved edits. `request` is the shell's ask: the
 * Library's "Make a clean cut…" selects that recording, a Review ask (the
 * ready toast, the Library's "Review clean cut") opens that cut's review.
 */
export function CleanCutTab({
  client,
  request,
  onOpenLibrarySession
}: {
  client: CleanCutClient
  request: CleanCutTabRequest | null
  onOpenLibrarySession: (sessionId: string) => void
}): ReactElement {
  const stored = useOpenCleanCutReview()
  // A new ask shows at once; the store takes it right after.
  const pending = pendingCleanCutRequest(request)
  const review = pending ? cleanCutReviewTargetOf(pending) : stored
  useLayoutEffect(() => {
    if (pending) applyCleanCutRequest(pending)
  }, [pending])
  const focus: CleanCutFocus | null =
    request && !request.review
      ? {
          sessionId: request.sessionId,
          nonce: request.nonce,
          ...(request.origin ? { origin: request.origin } : {})
        }
      : null

  if (review) {
    return (
      <Suspense fallback={<CleanCutReviewFallback />}>
        {/* Keyed by its target: another cut is a fresh review (E-5). */}
        <CleanCutReview
          key={`${review.sessionId}:${review.mode}:${review.jobId ?? ''}`}
          client={client}
          target={review}
          onClose={closeCleanCutReview}
          onOpenLibrarySession={onOpenLibrarySession}
        />
      </Suspense>
    )
  }
  return (
    <CleanCutCard
      client={client}
      focus={focus}
      onOpenLibrarySession={onOpenLibrarySession}
      onReview={openCleanCutReview}
    />
  )
}

function CleanCutReviewFallback(): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      Loading the review…
    </div>
  )
}
