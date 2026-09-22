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
