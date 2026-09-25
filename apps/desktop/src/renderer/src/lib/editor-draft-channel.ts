import type { CameraTransform, EditorChrome, SceneEditorDraftParams } from '@/lib/backend'

/**
 * Live drafts from the Scene stage to the compositor (plan 058, decision 3).
 *
 * While a stage gesture runs over the live canvas, every animation-frame
 * sample becomes a `scene.editor.draft.set` so the real picture follows the
 * drag. This channel owns the wire discipline, and nothing else:
 *
 * - at most ONE `set` in flight; while one is pending only the newest sample
 *   is kept and sent when the response arrives (latest-wins);
 * - a heartbeat re-sends the last draft every `EDITOR_DRAFT_HEARTBEAT_MS`
 *   while a gesture is active and nothing else was sent, so the backend's
 *   2 s TTL never expires under a paused pointer;
 * - `cancel()` sends `scene.editor.draft.clear` once and drops any pending
 *   sample; `release(rect)` sends one final `set` with the rounded rect (the
 *   draft and the commit are then bit-identical) and stops the heartbeat but
 *   never clears: the backend drops the draft when the commit's revision
 *   installs, so the picture cannot flash back to the old rect;
 * - samples after `cancel()`/`release()` are ignored;
 * - a `set` refused with `EDITOR_DRAFT_REFUSED` disables the channel for the
 *   rest of that gesture (no retries, nothing thrown at the stage); any other
 *   rejection is swallowed after one debug log;
 * - a channel that is not `enabled` (the stage's `liveSurface`) never sends.
 *
 * Pure and DOM-free: timers and the clock are injectable for tests. The
 * authoritative commit (`StageEdits.submit`) is untouched by this module.
 */

export const EDITOR_DRAFT_HEARTBEAT_MS = 500
/** Backend error code when a session is active (decision 4). */
export const EDITOR_DRAFT_REFUSED = 'editor-draft-refused'

export interface EditorDraftSample {
  transform: CameraTransform
  chrome: EditorChrome
}

export interface EditorDraftTransport {
  set: (params: SceneEditorDraftParams) => Promise<unknown>
  clear: () => Promise<unknown>
}

export interface EditorDraftChannelOptions extends EditorDraftTransport {
  now?: () => number
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** One line per swallowed transport failure; defaults to `console.debug`. */
  log?: (message: string, error: unknown) => void
}

export interface EditorDraftChannel {
  /** Mirrors the stage's `liveSurface`; a disabled channel sends nothing. */
  enabled: boolean
  /** A gesture is open and has not been released or cancelled. */
  readonly active: boolean
  begin(sourceId: string): void
  sample(draft: EditorDraftSample): void
  release(rect: CameraTransform): void
  cancel(): void
  dispose(): void
}

type Gesture = {
  sourceId: string
  last: SceneEditorDraftParams | null
  /** Something reached the wire (or is queued for it): a cancel must clear. */
  sent: boolean
  refused: boolean
}

/** The wire contract is exactly `{x, y, width, height}` (`allowUnknown:
 * false`): a stage ghost that spreads a scene source's transform also carries
 * its crop fields, and the client validator would reject it before it left. */
const rectOf = ({ x, y, width, height }: CameraTransform): CameraTransform => ({
  x,
  y,
  width,
  height
})

export function createEditorDraftChannel(options: EditorDraftChannelOptions): EditorDraftChannel {
  const schedule = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms))
  const unschedule = options.clearTimeout ?? ((handle) => clearTimeout(handle as number))
  const log =
    options.log ??
    ((message: string, error: unknown) => {
      console.debug(message, error)
    })
  let enabled = false
  let disposed = false
  let gesture: Gesture | null = null
  let inFlight = false
  /** Newest message waiting for the wire, tagged with the gesture it belongs to. */
  let pending: { params: SceneEditorDraftParams; owner: Gesture } | null = null
  let heartbeat: unknown = null

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) unschedule(heartbeat)
    heartbeat = null
  }
  const armHeartbeat = (): void => {
    stopHeartbeat()
    const owner = gesture
    if (!owner || owner.refused || !owner.last) return
    heartbeat = schedule(() => {
      heartbeat = null
      if (gesture !== owner || owner.refused || !owner.last || !enabled) return
      if (inFlight) {
        // A slow response: the pending sample (if any) already supersedes the
        // heartbeat; otherwise resend the last draft when the wire frees up.
        pending ??= { params: owner.last, owner }
        return
      }
      dispatch(owner.last, owner)
    }, EDITOR_DRAFT_HEARTBEAT_MS)
  }
  const dispatch = (params: SceneEditorDraftParams, owner: Gesture): void => {
    inFlight = true
    owner.sent = true
    void options
      .set(params)
      .then(
        () => undefined,
        (error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === EDITOR_DRAFT_REFUSED) {
            owner.refused = true
            pending = null
            return
          }
          log('[editor-draft] set failed', error)
        }
      )
      .then(() => {
        inFlight = false
        if (disposed) return
        const next = pending
        pending = null
        // A released gesture's final still goes out after its owner ended
        // (gesture === null); a cancelled one never gets here (cancel drops it).
        if (next && !next.owner.refused && (gesture === next.owner || gesture === null)) {
          dispatch(next.params, next.owner)
          return
        }
        armHeartbeat()
      })
  }
  const sendClear = (): void => {
    void options.clear().catch((error: unknown) => {
      log('[editor-draft] clear failed', error)
    })
  }
  const end = (): void => {
    stopHeartbeat()
    gesture = null
    pending = null
  }

  return {
    get enabled() {
      return enabled
    },
    set enabled(value: boolean) {
      if (enabled === value) return
      enabled = value
      // The surface went away under an open gesture (an overlay, a pop-out):
      // do not leave a draft to expire on its own.
      if (!value && gesture) this.cancel()
    },
    get active() {
      return gesture !== null
    },
    begin(sourceId) {
      if (disposed) return
      if (gesture) this.cancel()
      gesture = { sourceId, last: null, sent: false, refused: false }
    },
    sample(draft) {
      const owner = gesture
      if (disposed || !owner || owner.refused || !enabled) return
      const params: SceneEditorDraftParams = {
        sourceId: owner.sourceId,
        transform: rectOf(draft.transform),
        chrome: { ...draft.chrome, selected: rectOf(draft.chrome.selected) }
      }
      owner.last = params
      if (inFlight) {
        pending = { params, owner }
        owner.sent = true
        return
      }
      dispatch(params, owner)
    },
    release(rect) {
      const owner = gesture
      if (disposed || !owner) return
      const last = owner.last
      end()
      if (owner.refused || !enabled || !last) return
      const { activeHandle: _activeHandle, ...chrome } = last.chrome
      const final: SceneEditorDraftParams = {
        sourceId: owner.sourceId,
        transform: rectOf(rect),
        chrome: { ...chrome, selected: rectOf(rect), guides: [] }
      }
      if (inFlight) {
        pending = { params: final, owner }
        return
      }
      dispatch(final, owner)
    },
    cancel() {
      const owner = gesture
      if (!owner) return
      end()
      if (owner.sent && !owner.refused) sendClear()
    },
    dispose() {
      if (disposed) return
      this.cancel()
      disposed = true
    }
  }
}
