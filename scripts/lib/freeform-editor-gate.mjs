/** Analyze measured CSS-pixel trajectories from the real Scene editor. */
export function evaluateFreeformGesture(gesture) {
  const failures = []
  const tolerance = 1
  if (!gesture.frames?.length) failures.push('no displayed frames')
  if (gesture.captured !== true) failures.push('pointer capture was not acquired')
  if (gesture.quickEdits && gesture.captureCount !== 2)
    failures.push('both rapid edits must acquire pointer capture')
  if (gesture.pointerDowns || gesture.captureChecks) {
    const expectedDowns = gesture.quickEdits ? 2 : 1
    if (
      gesture.pointerDowns?.length !== expectedDowns ||
      gesture.captureChecks?.length !== expectedDowns
    )
      failures.push('missing pointerdown delivery or capture observation')
    else
      for (let index = 0; index < expectedDowns; index++) {
        const down = gesture.pointerDowns[index],
          check = gesture.captureChecks[index]
        if (
          !down.trusted ||
          !Number.isFinite(down.at) ||
          !Number.isFinite(check.at) ||
          check.at < down.at ||
          check.pointerId !== down.pointerId ||
          !check.captured
        )
          failures.push('capture observation did not follow its trusted pointerdown')
      }
  }
  const expectedCommits = gesture.cancelled || gesture.noop ? 0 : gesture.quickEdits ? 2 : 1
  if (gesture.commits?.length !== expectedCommits) {
    failures.push(
      `expected ${expectedCommits} transform commits, received ${gesture.commits?.length}`
    )
  }
  if (!validBox(gesture.finalRect) || !validBox(gesture.acceptedRect)) {
    failures.push('invalid final or authoritative geometry')
  }
  const latencies = []
  for (const frame of gesture.frames ?? []) {
    if (!validBox(frame.rect)) {
      failures.push('invalid displayed geometry')
      continue
    }
    if (
      frame.afterRelease === true &&
      !gesture.cancelled &&
      rectError(frame.rect, frame.releaseRect ?? gesture.finalRect) > tolerance
    ) {
      failures.push('old-position frame during release handoff')
    }
    if (frame.phase === 'dragging' && frame.commandedRects?.length) {
      if (!frame.commandedRects.every(validBox)) failures.push('invalid commanded geometry')
      if (frame.matchedInputIndex >= 0 && frame.matchedInputIndex < frame.previousInputIndex)
        failures.push('display returned to an already painted historical command')
      // Only recent unpainted commands or the immediately preceding painted frame
      // is admissible. Historical positions must never mask a backwards jump.
      const candidates = [...frame.commandedRects]
      if (
        validBox(frame.previousRect) &&
        Number.isFinite(frame.pendingAgeMs) &&
        frame.pendingAgeMs <= 33
      ) {
        candidates.push(frame.previousRect)
      }
      if (Math.min(...candidates.map((rect) => rectError(frame.rect, rect))) > tolerance) {
        failures.push('display discontinuity beyond commanded pointer motion')
      }
      if (
        frame.pendingAgeMs > 33 &&
        !(
          Number.isInteger(frame.matchedInputIndex) &&
          frame.matchedInputIndex > frame.previousInputIndex
        )
      )
        failures.push('unpainted pointer input exceeded 33ms')
    }
    if (Number.isFinite(frame.pointerToPaintMs)) latencies.push(frame.pointerToPaintMs)
  }
  if (!gesture.cancelled && !gesture.noop) {
    if (!gesture.revisionAdvanced) failures.push('backend scene revision did not advance')
    if (rectError(gesture.acceptedRect, gesture.finalRect) > tolerance) {
      failures.push('authoritative geometry differs from last displayed rectangle')
    }
    if (!latencies.length) failures.push('no pointer-to-paint samples')
  }
  const p95 = percentile(latencies, 95)
  if (p95 !== null && p95 > 33)
    failures.push(`pointer-to-paint p95 ${p95.toFixed(2)}ms exceeds 33ms`)
  if ((gesture.longTasks ?? []).some((task) => task.duration > 50)) {
    failures.push('gesture-attributable task exceeded 50ms')
  }
  return {
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    p95,
    samples: latencies.length
  }
}

export function evaluateFreeformChrome({
  canvas,
  toolbar,
  footer,
  handles,
  tinySourceBody,
  paintedCircle
}) {
  const failures = []
  if (![canvas, toolbar, footer].every(validBox)) failures.push('missing editor geometry')
  else {
    if (intersects(canvas, toolbar)) failures.push('toolbar intersects editable canvas')
    if (intersects(canvas, footer)) failures.push('footer intersects editable canvas')
  }
  if (tinySourceBody && (!validBox(tinySourceBody.box) || !tinySourceBody.hitMatches))
    failures.push('tiny source body is obstructed by its resize control')
  if (paintedCircle) {
    const { bounds, sourceBounds, tag } = paintedCircle
    if (
      tag !== 'circle' ||
      !validBox(bounds) ||
      !validBox(sourceBounds) ||
      Math.abs(bounds.width - bounds.height) > 1 ||
      Math.abs(bounds.x + bounds.width / 2 - sourceBounds.x - sourceBounds.width / 2) > 1 ||
      Math.abs(bounds.y + bounds.height / 2 - sourceBounds.y - sourceBounds.height / 2) > 1
    )
      failures.push('camera circle is not circular and centered inside its bounds')
  }
  if (!handles?.length) failures.push('no reachable resize affordance')
  for (const [index, handle] of (handles ?? []).entries()) {
    if (!validBox(handle.box) || !handle.hitMatches)
      failures.push(`handle ${handle.id} is unreachable`)
    for (const other of handles.slice(index + 1)) {
      if (intersects(handle.box, other.box))
        failures.push(`handles ${handle.id}/${other.id} overlap`)
    }
  }
  return { ok: failures.length === 0, failures }
}

export function rectError(a, b) {
  if (!validBox(a) || !validBox(b)) return Infinity
  return Math.max(...['x', 'y', 'width', 'height'].map((key) => Math.abs(a[key] - b[key])))
}

function validBox(box) {
  return (
    box &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(box[key])) &&
    box.width > 0 &&
    box.height > 0
  )
}
function intersects(a, b) {
  return (
    validBox(a) &&
    validBox(b) &&
    a.x < b.x + b.width - 0.1 &&
    b.x < a.x + a.width - 0.1 &&
    a.y < b.y + b.height - 0.1 &&
    b.y < a.y + a.height - 0.1
  )
}
function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

/** Pixel oracle for two disjoint synthetic sources on the compositor's dark canvas. */
export function evaluateFreeformArtifact({ pixels, width, height, rects }) {
  const failures = []
  if (!pixels || pixels.length !== width * height * 3 || rects?.length !== 2) {
    return { ok: false, failures: ['missing decoded RGB frame or two source rectangles'] }
  }
  const boxes = rects.map((rect) => ({
    x: rect.x * width,
    y: rect.y * height,
    width: rect.width * width,
    height: rect.height * height
  }))
  if (!boxes.every(validBox)) return { ok: false, failures: ['invalid source rectangle'] }
  const contains = (box, x, y, pad = 0) =>
    x >= box.x - pad &&
    y >= box.y - pad &&
    x < box.x + box.width + pad &&
    y < box.y + box.height + pad
  const detected = boxes.map(() => ({
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
    pixels: 0
  }))
  let outsidePixels = 0
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3
      // Synthetic source base has B >= 80; compositor background is near black.
      // 50 keeps codec ringing outside a source from becoming false content.
      if (Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 50) continue
      if (!boxes.some((box) => contains(box, x, y, 3))) outsidePixels++
      boxes.forEach((box, index) => {
        if (!contains(box, x, y, 4)) return
        const found = detected[index]
        found.left = Math.min(found.left, x)
        found.top = Math.min(found.top, y)
        found.right = Math.max(found.right, x + 1)
        found.bottom = Math.max(found.bottom, y + 1)
        found.pixels++
      })
    }
  if (outsidePixels / (width * height) > 0.002)
    failures.push('foreground outside committed source rectangles')
  const measurements = boxes.map((box, index) => {
    const found = detected[index]
    const coverage = found.pixels / (box.width * box.height)
    const error = Math.max(
      Math.abs(found.left - box.x),
      Math.abs(found.top - box.y),
      Math.abs(found.right - box.x - box.width),
      Math.abs(found.bottom - box.y - box.height)
    )
    if (coverage < 0.8 || error > 3)
      failures.push(`source ${index} decoded bounds differ from committed placement`)
    return { expected: box, detected: found, coverage, error }
  })
  return { ok: failures.length === 0, failures, outsidePixels, measurements }
}

/** Population statistics preserve every measured pointer sample, without averaging p95s. */
export function summarizeFreeformTiming(gestures) {
  const summarize = (subset) => {
    const samples = subset.flatMap((gesture) =>
      (gesture.frames ?? []).map((frame) => frame.pointerToPaintMs).filter(Number.isFinite)
    )
    return {
      gestures: subset.length,
      samples: samples.length,
      p95: percentile(samples, 95),
      max: samples.length ? Math.max(...samples) : null,
      maximumGestureP95: Math.max(0, ...subset.map((gesture) => gesture.gate?.p95 ?? 0))
    }
  }
  return {
    aggregate: summarize(gestures),
    byOrientation: Object.fromEntries(
      [...new Set(gestures.map((gesture) => gesture.orientation))].map((orientation) => [
        orientation,
        summarize(gestures.filter((gesture) => gesture.orientation === orientation))
      ])
    )
  }
}

/**
 * Live canvas (plan 058 S4): one gesture's editor-draft evidence.
 *
 * `samples` are mid-drag pairs of the DOM ghost (normalized to the canvas) and
 * the backend's `compositor.status.editorDraft` read right after it; `final`
 * is the converged pair at the last pointer position before release. Wire
 * evidence (`wireDrafts`, `wireClears`, `commits`) comes from the renderer's
 * socket hook, so the bit-identical draft/commit check never depends on
 * backend sanitizing. Timings are milliseconds from release/cancel.
 */
export function evaluateLiveDraftGesture({
  sourceId,
  samples = [],
  final,
  wireDrafts = [],
  wireClears = [],
  commits = [],
  committedTransform,
  revisionAfter,
  goneMs,
  lastPresent,
  cancelled = false,
  noop = false,
  tolerance = 1e-3,
  goneBudgetMs = 1000,
  clearBudgetMs = 500
}) {
  const failures = []
  for (const sample of samples)
    if (sample.draft && sample.draft.sourceId !== sourceId)
      failures.push(`draft names ${sample.draft.sourceId}, gesture edits ${sourceId}`)
  if (!wireDrafts.length) failures.push('no scene.editor.draft.set left the renderer')
  if (!final?.draft) failures.push('no draft on the backend at the last pointer position')
  else if (final.draft.sourceId !== sourceId) failures.push('final draft names another source')
  else if (rectError(final.draft.transform, final.ghost) > tolerance)
    failures.push(
      `final draft misses the DOM ghost by ${rectError(final.draft.transform, final.ghost).toFixed(5)}`
    )
  const expectClear = cancelled || noop
  const releaseDrafts = wireDrafts.filter((draft) => draft.afterRelease)
  if (expectClear) {
    if (wireClears.length !== 1)
      failures.push(`expected one scene.editor.draft.clear, received ${wireClears.length}`)
    if (releaseDrafts.length) failures.push('a cancelled gesture still sent a release draft')
    if (!Number.isFinite(goneMs) || goneMs > clearBudgetMs)
      failures.push(`draft still applied ${describeMs(goneMs)} after cancel (budget ${clearBudgetMs}ms)`)
  } else {
    if (wireClears.length) failures.push('a released gesture must not clear its draft')
    if (releaseDrafts.length !== 1)
      failures.push(`expected one release draft, received ${releaseDrafts.length}`)
    if (commits.length !== 1) failures.push(`expected one commit, received ${commits.length}`)
    const releaseDraft = releaseDrafts[0]
    const commit = commits[0]
    if (releaseDraft && commit) {
      if (!sameRect(releaseDraft.transform, commit.transform))
        failures.push('release draft and commit differ on the wire (must be bit-identical)')
      if (releaseDraft.chrome?.guides?.length || releaseDraft.chrome?.activeHandle)
        failures.push('release draft still carries guides or an active handle')
    }
    if (!Number.isFinite(goneMs) || goneMs > goneBudgetMs)
      failures.push(`draft still applied ${describeMs(goneMs)} after release (budget ${goneBudgetMs}ms)`)
    if (lastPresent) {
      if (
        lastPresent.releaseAtRevision !== undefined &&
        lastPresent.releaseAtRevision !== revisionAfter
      )
        failures.push(
          `draft was stamped for revision ${lastPresent.releaseAtRevision}, scene installed ${revisionAfter}`
        )
      if (committedTransform && rectError(lastPresent.transform, committedTransform) > tolerance)
        failures.push('last applied draft differs from the committed transform')
    }
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)] }
}

/**
 * Preview cadence from sparse `framesRendered` readings, each stamped with
 * `at` (reply time) and, when known, `requestedAt` (or `rttMs`).
 *
 * The gate is the longest STALL between two counter advances. A reading
 * observes the counter somewhere between its request and its reply, so for a
 * run of equal readings j..k-1 ended by the advance at k the stall lies in
 * [request(k-1) - reply(j), reply(k) - request(j-1)]. The gate uses the LOWER
 * bound (the stall that provably happened) against `maxGapFrames`; the upper
 * bound is reported. A slow status round trip (> `slowRttMs`) is itself
 * evidence of a backend hitch and is counted. Steady under-rate (a window at
 * 55 fps instead of 60) is not a gap: it is reported as the worst window over
 * `windowMs` and never fails the gate.
 */
export function evaluatePreviewCadence({
  samples,
  fps,
  maxGapFrames = 2,
  windowMs = 1000,
  slowRttMs = 30
}) {
  const failures = []
  const valid = (samples ?? [])
    .filter((sample) => Number.isFinite(sample?.at) && Number.isFinite(sample?.framesRendered))
    .map((sample) => ({
      ...sample,
      requestedAt: Number.isFinite(sample.requestedAt)
        ? sample.requestedAt
        : sample.at - (Number.isFinite(sample.rttMs) ? sample.rttMs : 0)
    }))
  if (!Number.isFinite(fps) || fps <= 0) return { ok: false, failures: ['no preview fps'] }
  if (valid.length < 3) return { ok: false, failures: ['fewer than three cadence samples'] }
  const frameMs = 1000 / fps
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].at < valid[i - 1].at) return { ok: false, failures: ['cadence samples out of order'] }
    if (valid[i].framesRendered < valid[i - 1].framesRendered)
      return { ok: false, failures: ['framesRendered went backwards'] }
  }
  const intervals = valid.slice(1).map((sample, i) => sample.at - valid[i].at)
  const medianIntervalMs = [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)]
  let worst = { provenMs: 0, boundMs: 0, at: null }
  let advanced = 0
  let runStart = 0
  const consider = (j, k, open) => {
    // Readings j..k-1 agree; k is the advance (or the end of sampling).
    const provenMs = Math.max(0, valid[Math.max(j, k - 1)].requestedAt - valid[j].at)
    const boundMs = valid[k].at - valid[Math.max(0, j - 1)].requestedAt
    if (provenMs > worst.provenMs || (provenMs === worst.provenMs && boundMs > worst.boundMs))
      worst = { provenMs, boundMs, at: valid[j].at, open }
  }
  for (let k = 1; k < valid.length; k++) {
    if (valid[k].framesRendered > valid[k - 1].framesRendered) {
      advanced++
      consider(runStart, k, false)
      runStart = k
    }
  }
  if (runStart < valid.length - 1) consider(runStart, valid.length - 1, true)
  let worstWindow = { missingFrames: -Infinity, spanMs: 0, at: null }
  for (let i = 0; i < valid.length; i++)
    for (let j = i + 1; j < valid.length; j++) {
      const spanMs = valid[j].at - valid[i].at
      if (spanMs > windowMs) break
      if (spanMs < windowMs / 2) continue
      const missingFrames = spanMs / frameMs - (valid[j].framesRendered - valid[i].framesRendered)
      if (missingFrames > worstWindow.missingFrames)
        worstWindow = { missingFrames, spanMs, at: valid[i].at }
    }
  const slowRtts = valid.filter((sample) => sample.at - sample.requestedAt > slowRttMs)
  const budgetMs = maxGapFrames * frameMs
  if (!advanced) failures.push('framesRendered never advanced')
  else if (worst.provenMs > budgetMs)
    failures.push(
      `preview stalled at least ${worst.provenMs.toFixed(0)}ms (${(worst.provenMs / frameMs).toFixed(2)} frames, at most ${worst.boundMs.toFixed(0)}ms) against a budget of ${maxGapFrames} frames`
    )
  const spanMs = valid.at(-1).at - valid[0].at
  return {
    ok: failures.length === 0,
    failures,
    provenStallMs: worst.provenMs,
    provenStallFrames: worst.provenMs / frameMs,
    boundStallMs: worst.boundMs,
    boundStallFrames: worst.boundMs / frameMs,
    worstStallAt: worst.at,
    budgetMs,
    medianIntervalMs,
    slowRtts: slowRtts.length,
    maxRttMs: Math.max(0, ...valid.map((sample) => sample.at - sample.requestedAt)),
    worstWindowMissingFrames: Number.isFinite(worstWindow.missingFrames)
      ? worstWindow.missingFrames
      : null,
    minWindowFps:
      Number.isFinite(worstWindow.missingFrames) && worstWindow.spanMs > 0
        ? fps - (worstWindow.missingFrames * 1000) / worstWindow.spanMs
        : null,
    samples: valid.length,
    spanMs,
    meanFps:
      spanMs > 0 ? ((valid.at(-1).framesRendered - valid[0].framesRendered) * 1000) / spanMs : null
  }
}

function sameRect(a, b) {
  return (
    validBox(a) && validBox(b) && ['x', 'y', 'width', 'height'].every((key) => a[key] === b[key])
  )
}
function describeMs(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)}ms` : 'indefinitely'
}
