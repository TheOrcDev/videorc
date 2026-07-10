import type { CommentsViewMode } from '../shared/backend'

export interface CommentsCommandResolution<T> {
  requestId: string
  ok: boolean
  value?: T
  error?: string
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseCommentsViewMode(value: unknown): CommentsViewMode | null {
  if (!value || typeof value !== 'object' || !('kind' in value)) return null
  if (value.kind === 'live') return { kind: 'live' }
  if (
    value.kind === 'history' &&
    'sessionId' in value &&
    nonEmptyString(value.sessionId) &&
    'title' in value &&
    typeof value.title === 'string' &&
    'startedAt' in value &&
    nonEmptyString(value.startedAt)
  ) {
    return {
      kind: 'history',
      sessionId: value.sessionId,
      title: value.title,
      startedAt: value.startedAt
    }
  }
  return null
}

export function commentsViewModeSenderAllowed(params: {
  senderId: number
  mainRendererId?: number
  commentsRendererId?: number
  mode: CommentsViewMode
}): boolean {
  if (params.senderId === params.mainRendererId) return true
  return params.senderId === params.commentsRendererId && params.mode.kind === 'live'
}

export function liveCommentsCommandAllowed(params: {
  mode: CommentsViewMode
  liveSessionId?: string
  commandSessionId?: string
}): boolean {
  return (
    params.mode.kind === 'live' &&
    nonEmptyString(params.liveSessionId) &&
    params.commandSessionId === params.liveSessionId
  )
}

interface PendingCommand {
  timeout: ReturnType<typeof setTimeout>
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Correlates detached Comments-window commands with the main renderer that
 * owns the backend socket. Missing/reloaded renderers always reach a terminal
 * timeout instead of leaving the window pending forever. */
export class CommentsCommandBroker {
  private readonly pending = new Map<string, PendingCommand>()

  constructor(private readonly timeoutMs = 10_000) {}

  request<T>(requestId: string, dispatch: () => boolean): Promise<T> {
    if (!requestId || this.pending.has(requestId)) {
      return Promise.reject(new Error('Duplicate or missing Comments request id.'))
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Comments command timed out because the Studio renderer did not reply.'))
      }, this.timeoutMs)
      this.pending.set(requestId, {
        timeout,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      let dispatched: boolean
      try {
        dispatched = dispatch()
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error('Could not dispatch Comments command.'))
        return
      }
      if (!dispatched) {
        clearTimeout(timeout)
        this.pending.delete(requestId)
        reject(new Error('Studio is unavailable. Reopen Videorc and try again.'))
      }
    })
  }

  resolve<T>(resolution: CommentsCommandResolution<T>): boolean {
    const pending = this.pending.get(resolution.requestId)
    if (!pending) return false
    clearTimeout(pending.timeout)
    this.pending.delete(resolution.requestId)
    if (resolution.ok) {
      pending.resolve(resolution.value)
    } else {
      pending.reject(new Error(resolution.error || 'Comments command failed.'))
    }
    return true
  }

  rejectAll(reason = 'Studio renderer closed before the Comments command completed.'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
