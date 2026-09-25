import type { CameraTransform, EditorChrome, SceneEditorDraftParams } from '@/lib/backend'

/**
 * Live drafts from the Scene stage to the compositor (plan 058, decision 3).
 *
 * While a stage gesture runs over the live canvas, every animation-frame
 * sample becomes a `scene.editor.draft.set` so the real picture follows the
 * drag. Between gestures the stage HOLDS the idle selection: a chrome-only
 * draft (no `transform`) for the selected source, so its frame and handles
 * stay on the live picture and there is something to grab. This channel owns
 * the wire discipline, and nothing else:
 *
 * - at most ONE `set` in flight; while one is pending only the newest sample
 *   is kept and sent when the response arrives (latest-wins);
 * - a heartbeat re-sends the last draft (a gesture's sample or the hold) every
 *   `EDITOR_DRAFT_HEARTBEAT_MS` while nothing else was sent, so the backend's
 *   2 s TTL never expires under a paused pointer or an idle selection;
 * - `hold(sourceId, chrome)` sends the chrome-only draft (coalesced under the
 *   same one-in-flight rule; an identical hold already on the wire is a
 *   no-op) and `hold(null)` clears the wire once and stops the heartbeat;
 * - a gesture (`begin` … `release`/`cancel`) suspends the hold: `cancel()`
 *   sends `scene.editor.draft.clear` once, drops any pending sample and
 *   re-sends the hold at once; `release(rect)` sends one final `set` with the
 *   rounded rect (the draft and the commit are then bit-identical), stops the
 *   heartbeat, never clears, and FORGETS the hold: the backend drops the
 *   released draft when the commit's revision installs, and the stage holds
 *   again when the committed scene arrives. A hold sent any earlier would
 *   replace the released rect and let the picture snap back;
 * - samples after `cancel()`/`release()` are ignored;
 * - a `set` refused with `EDITOR_DRAFT_REFUSED` disables the rest of that
 *   gesture, or drops that hold, with no retries and nothing thrown at the
 *   stage (the next `hold(...)` call starts clean); any other rejection is
 *   swallowed after one debug log;
 * - a channel that is not `enabled` (the stage's `liveSurface`) never sends:
 *   the hold is remembered and sent when it is enabled again. Disabling
 *   cancels an open gesture and clears whatever reached the wire, so nothing
 *   lingers on a surface that just popped out or went under an overlay.
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
  /** The idle selection: a chrome-only draft for `sourceId`, heartbeated while
   * held and suspended by a gesture. `hold(null)` releases it (one clear). */
  hold(sourceId: string, chrome: EditorChrome): void
  hold(sourceId: null): void
  begin(sourceId: string): void
  sample(draft: EditorDraftSample): void
  release(rect: CameraTransform): void
  cancel(): void
  dispose(): void
}

type Owner = {
  sourceId: string
  last: SceneEditorDraftParams | null
  /** Something reached the wire (or is queued for it): a cancel must clear. */
  sent: boolean
  refused: boolean
}
type Gesture = Owner & { kind: 'gesture' }
type Hold = Owner & {
  kind: 'hold'
  last: SceneEditorDraftParams
  /** Must reach the wire when it is next free (set by `hold`, a cancel, a
   * re-enable, or a heartbeat that found a set in flight). */
  dirty: boolean
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
const sameRect = (a: CameraTransform, b: CameraTransform): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const sameChrome = (a: EditorChrome, b: EditorChrome): boolean =>
  sameRect(a.selected, b.selected) &&
  a.handles === b.handles &&
  a.activeHandle === b.activeHandle &&
  a.scale === b.scale &&
  a.guides.length === b.guides.length &&
  a.guides.every(
    (guide, index) =>
      guide.axis === b.guides[index]!.axis && guide.position === b.guides[index]!.position
  )

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
  let hold: Hold | null = null
  let inFlight = false
  /** Newest gesture message waiting for the wire, tagged with its gesture. */
  let pending: { params: SceneEditorDraftParams; owner: Gesture } | null = null
  let heartbeat: unknown = null
  /** A set reached the wire since the last clear: dropping the hold must clear. */
  let wireDirty = false

  /** Whose draft the wire carries: an open gesture, else the hold. */
  const current = (): Owner | null => gesture ?? hold
  const stopHeartbeat = (): void => {
    if (heartbeat !== null) unschedule(heartbeat)
    heartbeat = null
  }
  const armHeartbeat = (): void => {
    stopHeartbeat()
    const owner = current()
    if (!owner || owner.refused || !owner.last) return
    heartbeat = schedule(() => {
      heartbeat = null
      if (current() !== owner || owner.refused || !owner.last || !enabled) return
      if (inFlight) {
        // A slow response: the pending sample (if any) already supersedes the
        // heartbeat; otherwise resend the last draft when the wire frees up.
        if (hold && owner === hold) hold.dirty = true
        else if (gesture) pending ??= { params: owner.last, owner: gesture }
        return
      }
      dispatch(owner.last, owner)
    }, EDITOR_DRAFT_HEARTBEAT_MS)
  }
  const dispatch = (params: SceneEditorDraftParams, owner: Owner): void => {
    inFlight = true
    owner.sent = true
    wireDirty = true
    if (hold && owner === hold) hold.dirty = false
    void options
      .set(params)
      .then(
        () => undefined,
        (error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === EDITOR_DRAFT_REFUSED) {
            owner.refused = true
            if (pending?.owner === owner) pending = null
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
        if (!gesture && hold && hold.dirty && !hold.refused && enabled) {
          dispatch(hold.last, hold)
          return
        }
        armHeartbeat()
      })
  }
  const sendClear = (): void => {
    wireDirty = false
    void options.clear().catch((error: unknown) => {
      log('[editor-draft] clear failed', error)
    })
  }
  /** The hold takes the wire as soon as no gesture owns it. */
  const pushHold = (): void => {
    const held = hold
    if (!held || held.refused || !enabled || gesture) return
    held.dirty = true
    if (inFlight) return
    dispatch(held.last, held)
  }
  const endGesture = (): void => {
    stopHeartbeat()
    gesture = null
    pending = null
  }
  const cancelGesture = (rehold: boolean): void => {
    const owner = gesture
    if (!owner) return
    endGesture()
    if (owner.sent && !owner.refused) sendClear()
    if (rehold) pushHold()
  }
  const dropHold = (): void => {
    hold = null
    if (gesture) return
    stopHeartbeat()
    if (wireDirty) sendClear()
  }

  return {
    get enabled() {
      return enabled
    },
    set enabled(value: boolean) {
      if (enabled === value) return
      enabled = value
      if (!value) {
        // The surface went away (an overlay, a pop-out): do not leave a
        // gesture draft or the selection chrome to expire on their own. The
        // hold itself is remembered for when the surface comes back.
        cancelGesture(false)
        stopHeartbeat()
        if (wireDirty) sendClear()
        return
      }
      pushHold()
    },
    get active() {
      return gesture !== null
    },
    hold(sourceId: string | null, chrome?: EditorChrome) {
      if (disposed) return
      if (sourceId === null || !chrome) {
        dropHold()
        return
      }
      const params: SceneEditorDraftParams = {
        sourceId,
        chrome: { ...chrome, selected: rectOf(chrome.selected) }
      }
      // The same hold already on the wire (and heartbeating) is a no-op, so a
      // stage effect re-running on an unrelated dependency never double-sends.
      if (
        hold &&
        !hold.refused &&
        !hold.dirty &&
        hold.sent &&
        hold.sourceId === sourceId &&
        sameChrome(hold.last.chrome, params.chrome)
      )
        return
      hold = { kind: 'hold', sourceId, last: params, sent: false, refused: false, dirty: true }
      pushHold()
    },
    begin(sourceId) {
      if (disposed) return
      cancelGesture(false)
      stopHeartbeat()
      gesture = { kind: 'gesture', sourceId, last: null, sent: false, refused: false }
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
      endGesture()
      // The released draft ends at its commit; a hold sent before then would
      // replace its rect. The stage holds again once the committed scene lands.
      hold = null
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
      cancelGesture(true)
    },
    dispose() {
      if (disposed) return
      cancelGesture(false)
      dropHold()
      disposed = true
    }
  }
}
