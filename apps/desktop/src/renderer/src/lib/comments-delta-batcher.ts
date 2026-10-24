// The Stream Manager's chat deltas, applied once per frame (plan 191). Main
// relays one delta per chat message, so busy chat (20 to 50 a second) used to
// render the whole window, and reconcile its 2,000 rows, once per message.
// Deltas now queue and apply together, in arrival order, at the next frame:
// the window shows exactly what it showed before, at most one frame later.
// Pure (no React, no DOM): the scheduler is injected, like the main window's
// LiveChatMessageBatcher.

import type { CommentsSnapshotDelta, CommentsViewSnapshot } from '../../../shared/backend'
import { applyCommentsSnapshotDelta } from '../../../shared/comments-snapshot-delta'

/** How long a queued delta waits when no frame comes (a hidden or occluded window gets none). */
export const COMMENTS_DELTA_FLUSH_FALLBACK_MS = 16

export interface CommentsDeltaBatcherOptions {
  /** The window's view at flush time; queued deltas apply only while it is live. */
  view: () => CommentsViewSnapshot
  /** Takes the view the queued deltas produced: once per flush, and only when they changed it. */
  commit: (view: CommentsViewSnapshot) => void
  /** Runs `flush` later and returns a cancel. */
  schedule: (flush: () => void) => () => void
}

export class CommentsDeltaBatcher {
  private readonly view: () => CommentsViewSnapshot
  private readonly commit: (view: CommentsViewSnapshot) => void
  private readonly schedule: (flush: () => void) => () => void
  private queue: CommentsSnapshotDelta[] = []
  private cancelScheduledFlush: (() => void) | null = null
  private disposed = false

  constructor({ view, commit, schedule }: CommentsDeltaBatcherOptions) {
    this.view = view
    this.commit = commit
    this.schedule = schedule
  }

  push(delta: CommentsSnapshotDelta): void {
    if (this.disposed) return
    this.queue.push(delta)
    if (!this.cancelScheduledFlush) {
      this.cancelScheduledFlush = this.schedule(() => {
        this.cancelScheduledFlush = null
        this.flush()
      })
    }
  }

  /** Applies every queued delta now, in arrival order, onto the view as it is now. */
  flush(): void {
    this.cancelPendingFlush()
    const deltas = this.queue
    this.queue = []
    if (this.disposed || deltas.length === 0) return
    const current = this.view()
    // The same check each delta met when it applied on arrival: a view that
    // is no longer live takes none of them.
    if (current.mode.kind !== 'live') return
    let snapshot = current.snapshot
    for (const delta of deltas) snapshot = applyCommentsSnapshotDelta(snapshot, delta)
    if (snapshot !== current.snapshot) this.commit({ ...current, snapshot })
  }

  /** A full snapshot replaces the view, so it drops every delta queued before it. */
  supersede(): void {
    this.cancelPendingFlush()
    this.queue = []
  }

  dispose(): void {
    this.supersede()
    this.disposed = true
  }

  private cancelPendingFlush(): void {
    this.cancelScheduledFlush?.()
    this.cancelScheduledFlush = null
  }
}

/**
 * Runs `flush` at the next animation frame, or after the 16 ms fallback when
 * frames stop (a hidden window gets no frames), whichever comes first.
 */
export function scheduleCommentsDeltaFlush(flush: () => void): () => void {
  let frame: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    if (frame !== null) cancelAnimationFrame(frame)
    if (timer !== null) clearTimeout(timer)
    frame = null
    timer = null
  }
  const run = (): void => {
    cancel()
    flush()
  }
  if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(run)
  timer = setTimeout(run, COMMENTS_DELTA_FLUSH_FALLBACK_MS)
  return cancel
}
