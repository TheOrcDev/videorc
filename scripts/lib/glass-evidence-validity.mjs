const OWNER_CATEGORIES = new Set(['target-app', 'system-dialog', 'other-app'])
const MAX_METADATA_AGE_MS = 1000

export class InvalidGlassEvidenceError extends Error {
  constructor(diagnostic) {
    super(`Glass evidence INVALID: ${diagnostic.reason}.`)
    this.name = 'InvalidGlassEvidenceError'
    this.diagnostic = diagnostic
  }
}

function intersection(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

function validRect(rect) {
  return (
    rect &&
    ['x', 'y', 'width', 'height'].every((field) => Number.isFinite(rect[field])) &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function sameRect(a, b) {
  return (
    validRect(a) &&
    validRect(b) &&
    ['x', 'y', 'width', 'height'].every((field) => a[field] === b[field])
  )
}

function contains(a, b) {
  return (
    validRect(a) &&
    validRect(b) &&
    b.x >= a.x &&
    b.y >= a.y &&
    b.x + b.width <= a.x + a.width &&
    b.y + b.height <= a.y + a.height
  )
}

/** Only reduced validity data escapes; CGWindow identities remain transient. */
export function validateGlassWindowSnapshot({
  role,
  raised,
  rect = raised?.bounds,
  reference = false,
  snapshot,
  now,
  notBefore = now - MAX_METADATA_AGE_MS,
  expectedOwnership,
  phase = 'before'
}) {
  const timestamp = Number.isFinite(snapshot?.observedAt) ? snapshot.observedAt : now
  const diagnostic = {
    role,
    phase,
    status: 'VALID',
    ownerCategory: reference ? 'controlled-backdrop' : 'target-app',
    intersection: null,
    timestamp
  }
  const invalid = (reason, ownerCategory = 'unknown', overlap = null) => {
    throw new InvalidGlassEvidenceError({
      ...diagnostic,
      status: 'INVALID',
      reason,
      ownerCategory,
      intersection: overlap
    })
  }
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(snapshot?.observedAt) ||
    snapshot.observedAt < notBefore ||
    snapshot.observedAt > now ||
    now - snapshot.observedAt > MAX_METADATA_AGE_MS ||
    !Array.isArray(snapshot.windows)
  ) {
    invalid('metadata-missing-or-stale')
  }
  if (
    !Number.isSafeInteger(raised?.windowId) ||
    raised.windowId <= 0 ||
    !validRect(raised.bounds) ||
    !validRect(raised.primaryWorkArea) ||
    !validRect(rect)
  )
    invalid('target-metadata-missing')
  const windows = snapshot.windows
  const ids = new Set()
  const orders = new Set()
  for (const window of windows) {
    if (
      !Number.isSafeInteger(window.id) ||
      window.id <= 0 ||
      !Number.isSafeInteger(window.pid) ||
      window.pid <= 0 ||
      !Number.isSafeInteger(window.order) ||
      window.order < 0 ||
      !Number.isFinite(window.layer) ||
      !Number.isFinite(window.alpha) ||
      window.alpha < 0 ||
      window.alpha > 1 ||
      !validRect(window) ||
      !OWNER_CATEGORIES.has(window.ownerCategory) ||
      ids.has(window.id) ||
      orders.has(window.order)
    )
      invalid('window-metadata-ambiguous')
    ids.add(window.id)
    orders.add(window.order)
  }
  const targets = windows.filter((window) => window.id === raised.windowId)
  if (targets.length !== 1) invalid('target-not-visible')
  const target = targets[0]
  if (
    target.ownerCategory !== 'target-app' ||
    target.alpha <= 0 ||
    !sameRect(target, raised.bounds)
  )
    invalid('target-identity-or-geometry-mismatch')
  // The smoke reply authenticates the exact target ID. Its CGWindow PID owns
  // the one full-work-area backdrop; the launcher/controller PID is irrelevant.
  const backdrops = windows.filter(
    (window) =>
      window.id !== target.id &&
      window.pid === target.pid &&
      window.ownerCategory === 'target-app' &&
      window.alpha > 0 &&
      window.order > target.order &&
      sameRect(window, raised.primaryWorkArea)
  )
  if (backdrops.length !== 1) invalid('controlled-backdrop-missing-or-ambiguous')
  const backdrop = backdrops[0]
  if (!contains(reference ? backdrop : target, rect) || !contains(backdrop, rect))
    invalid('capture-region-outside-owner')
  const ownership = {
    targetId: target.id,
    targetPid: target.pid,
    targetLayer: target.layer,
    targetBounds: { ...raised.bounds },
    backdropId: backdrop.id,
    backdropPid: backdrop.pid,
    backdropLayer: backdrop.layer,
    backdropBounds: { ...raised.primaryWorkArea }
  }
  if (
    expectedOwnership &&
    (ownership.targetId !== expectedOwnership.targetId ||
      ownership.targetPid !== expectedOwnership.targetPid ||
      ownership.targetLayer !== expectedOwnership.targetLayer ||
      !sameRect(ownership.targetBounds, expectedOwnership.targetBounds) ||
      ownership.backdropId !== expectedOwnership.backdropId ||
      ownership.backdropPid !== expectedOwnership.backdropPid ||
      ownership.backdropLayer !== expectedOwnership.backdropLayer ||
      !sameRect(ownership.backdropBounds, expectedOwnership.backdropBounds))
  )
    invalid('capture-owner-changed')
  for (const window of windows) {
    // Glass can transmit a foreign window between the target and backdrop.
    // Windows behind the controlled backdrop cannot contribute captured pixels.
    if (
      (window.id === target.id && !reference) ||
      window.id === backdrop.id ||
      window.alpha <= 0 ||
      window.order > backdrop.order
    )
      continue
    const overlap = intersection(window, rect)
    if (!overlap) continue
    const category =
      window.pid === target.pid
        ? 'owned-app'
        : window.ownerCategory === 'system-dialog'
          ? 'system-dialog'
          : 'other-app'
    invalid(
      window.order < target.order || reference
        ? 'capture-obstructed'
        : 'controlled-backdrop-obstructed',
      category,
      overlap
    )
  }
  return { diagnostic, ownership }
}

/** Validate each actual capture rectangle immediately before and after pixels. */
export async function captureGlassEvidence({
  role,
  raised,
  capture,
  name,
  readWindows,
  now = Date.now,
  referenceRect,
  expectedOwnership,
  recordValidity = () => {}
}) {
  const rect = referenceRect ?? raised.bounds
  const read = async (phase, ownership) => {
    const requestedAt = now()
    let snapshot
    try {
      snapshot = await readWindows()
    } catch {
      throw new InvalidGlassEvidenceError({
        role,
        phase,
        status: 'INVALID',
        reason: 'window-metadata-unavailable',
        ownerCategory: 'unknown',
        intersection: null,
        timestamp: now()
      })
    }
    const result = validateGlassWindowSnapshot({
      role,
      raised,
      rect,
      reference: Boolean(referenceRect),
      snapshot,
      now: now(),
      notBefore: requestedAt,
      expectedOwnership: ownership,
      phase
    })
    recordValidity(result.diagnostic)
    return result
  }
  try {
    const before = await read('before', expectedOwnership)
    let file
    try {
      file = await capture(rect, name)
    } catch {
      throw new InvalidGlassEvidenceError({
        role,
        phase: 'capture',
        status: 'INVALID',
        reason: 'capture-unavailable',
        ownerCategory: 'unknown',
        intersection: null,
        timestamp: now()
      })
    }
    const after = await read('after', before.ownership)
    return { raised, file, ownership: after.ownership }
  } catch (error) {
    if (error instanceof InvalidGlassEvidenceError) recordValidity(error.diagnostic)
    throw error
  }
}

/** Invalidity overrides every score, including earlier rows and report mode. */
export function finalizeGlassEvidence(report, { gate = false, persistenceGated = false } = {}) {
  const validity = report.validity
  const invalid =
    validity?.status !== 'VALID' ||
    !validity.samples?.length ||
    validity.samples.some((sample) => sample.status !== 'VALID')
  if (invalid) {
    return {
      report: {
        ...report,
        validity: { ...validity, status: 'INVALID' },
        results: report.results.map(({ metrics, theme, role, sample }) => ({
          theme,
          role,
          sample,
          metrics,
          status: 'INVALID',
          checks: {},
          pass: null
        })),
        persistence:
          report.persistence?.map((row) =>
            row.skipped ? row : { ...row, status: 'INVALID', pass: null, failures: [] }
          ) ?? null
      },
      status: 'INVALID',
      failures: 0,
      persistenceFailures: 0,
      exitCode: 1
    }
  }
  const failures = report.results.filter((row) => !row.pass).length
  const persistenceFailures = (report.persistence ?? []).filter(
    (row) => !row.skipped && !row.pass
  ).length
  return {
    report: {
      ...report,
      results: report.results.map((row) => ({ ...row, status: row.pass ? 'PASS' : 'FAIL' }))
    },
    status: failures || (persistenceGated && persistenceFailures) ? 'FAIL' : 'PASS',
    failures,
    persistenceFailures,
    exitCode: gate && (failures || (persistenceGated && persistenceFailures)) ? 1 : 0
  }
}
