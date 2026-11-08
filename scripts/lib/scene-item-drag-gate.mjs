// Pure gates for `smoke:scene-item-drag`: a banner and the Buddy dragged on
// the Scene canvas show where they will drop, as they will look. On the live
// canvas (macOS, the preview docked into the canvas) and in the floating
// preview, every drag sample's editor draft (`compositor.status.editorDraft`)
// must carry the DOM ghost's rect, the dropped rect must stay on the picture
// until its save lands (no flash back to the old place), and the canvas must
// then rest: the live canvas holds the selection (a chrome-only draft), the
// floating preview holds nothing.

/** A DOM box in CSS px, normalized to the canvas box: canvas units 0 to 1. */
export function normalizeToCanvas(box, canvas) {
  return {
    x: (box.x - canvas.x) / canvas.width,
    y: (box.y - canvas.y) / canvas.height,
    width: box.width / canvas.width,
    height: box.height / canvas.height
  }
}

export function rectDistance(a, b) {
  return Math.max(...['x', 'y', 'width', 'height'].map((key) => Math.abs(a[key] - b[key])))
}

/** The draft names this stage item and carries a rect within `tolerance` of `rect`. */
export function draftCarriesRectFor(draft, stageId, rect, tolerance = 1e-3) {
  return Boolean(
    draft?.sourceId === stageId &&
    draft.transform &&
    rectDistance(draft.transform, rect) <= tolerance
  )
}

/** A stored overlay rect (`{x, y, w, h}`) as a stage rect. */
export function overlayRectAsStage(rect) {
  return { x: rect.x, y: rect.y, width: rect.w, height: rect.h }
}

/**
 * One drag's evidence.
 *
 * - `samples`: per pointer step, `{ ghost, draft, matchMs }`: the DOM ghost
 *   (canvas units) and the first backend draft that carried it (`matchMs` is
 *   null when none did within the smoke's budget).
 * - `released`: the ghost at release, in canvas units.
 * - `after`: every backend draft seen from release until the canvas rested,
 *   in order, and `rest`, the draft it rested on (null for none).
 * - `committed`: the rect the save stored, in canvas units.
 * - `mode`: `live` (docked) or `floating`.
 */
export function evaluateItemDrag({ stageId, mode, samples, released, after, rest, committed }) {
  const failures = []
  if (!samples.length) failures.push('no drag samples')
  samples.forEach((sample, index) => {
    if (!Number.isFinite(sample.matchMs))
      failures.push(
        `sample ${index}: the picture never followed the drag (draft ${JSON.stringify(sample.draft?.transform ?? null)}, ghost ${JSON.stringify(sample.ghost)})`
      )
  })
  if (!committed) failures.push('the drop was never saved')
  else if (rectDistance(committed, released) > 2e-3)
    failures.push(
      `saved ${JSON.stringify(committed)}, dropped at ${JSON.stringify(released)}: the drop did not land where it was shown`
    )
  // After release only the dropped rect may be on the picture: any other
  // rect-carrying draft is the old place flashing back (or a stale sample).
  for (const draft of after) {
    if (!draft?.transform) continue
    if (draft.sourceId !== stageId)
      failures.push(`after release a draft for ${draft.sourceId} carried a rect`)
    else if (rectDistance(draft.transform, released) > 2e-3)
      failures.push(
        `after release the picture showed ${JSON.stringify(draft.transform)}, not the drop ${JSON.stringify(released)}`
      )
  }
  if (mode === 'live') {
    if (rest?.sourceId !== stageId || rest.transform)
      failures.push(
        `the live canvas rested on ${JSON.stringify(rest)}, not the chrome-only hold of ${stageId}`
      )
  } else if (rest) {
    failures.push(`the floating preview rested on a draft: ${JSON.stringify(rest)}`)
  }
  return { ok: failures.length === 0, failures }
}

/**
 * The idle selection: the live canvas holds a chrome-only draft for the
 * selected item (for the Buddy that is what puts the pet on the idle
 * picture); the floating preview holds nothing.
 */
export function evaluateIdleSelection({ stageId, mode, draft }) {
  const failures = []
  if (mode === 'live') {
    if (!draft) failures.push(`no hold for the selected ${stageId}`)
    else if (draft.sourceId !== stageId)
      failures.push(`the hold names ${draft.sourceId}, the selection is ${stageId}`)
    else if (draft.transform) failures.push('the idle hold carries a rect (must be chrome-only)')
  } else if (draft) {
    failures.push(`the floating preview holds ${JSON.stringify(draft)} at rest`)
  }
  return { ok: failures.length === 0, failures }
}
