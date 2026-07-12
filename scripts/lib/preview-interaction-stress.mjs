export const PREVIEW_INTERACTION_STRESS_PROFILE = Object.freeze({
  floating: Object.freeze({
    positionUpdates: 120,
    cadenceMs: 16,
    burstUpdates: 60,
    burstCadenceMs: 4
  }),
  docked: Object.freeze({
    positionUpdates: 120,
    cadenceMs: 16,
    burstUpdates: 60,
    burstCadenceMs: 4
  }),
  sceneRounds: 10,
  sceneSequence: Object.freeze(['camera-only', 'screen-only', 'side-by-side', 'screen-camera']),
  sampleIntervalMs: 24,
  pixelOracle: Object.freeze({
    maxWidth: 320,
    maxHeight: 180,
    sampleIntervalMs: 200
  }),
  thresholds: Object.freeze({
    minPresentFps: 30,
    maxIntervalP95Ms: 120,
    maxInputToPresentP95Ms: 100,
    maxFrameStallMs: 250,
    maxSampleGapMs: 250,
    maxDroppedFrameDelta: 8,
    maxCompositorFrameLag: 8,
    maxHelperRequestDepth: 1,
    maxInProcessRequestDepth: 2,
    maxSurfaceOffsetPx: 6,
    minOracleCoverage: 0.8
  })
})

export function pixelOracleCaptureSize(
  width,
  height,
  {
    maxWidth = PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle.maxWidth,
    maxHeight = PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle.maxHeight
  } = {}
) {
  const sourceWidth = Math.max(1, finiteNumber(width) ?? 1)
  const sourceHeight = Math.max(1, finiteNumber(height) ?? 1)
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight)
  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale))
  }
}

/**
 * A 30 fps recording intentionally caps the shared compositor at 30 fps. Use
 * a small sampling tolerance at that cap, while preserving the full configured
 * floor for the normal 60 fps idle preview path.
 */
export function effectivePresentFpsFloor(configuredFloor, targetFps) {
  const configured = finiteNumber(configuredFloor)
  if (configured === null) return 0
  const target = finiteNumber(targetFps)
  if (target === null || target > configured) return configured
  return Math.min(configured, target * 0.95)
}

export function analyzeNativeStatusSamples(
  samples,
  {
    maxFrameStallMs,
    maxSampleGapMs,
    maxDroppedFrameDelta,
    maxCompositorFrameLag = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxCompositorFrameLag,
    maxHelperRequestDepth = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxHelperRequestDepth,
    maxInProcessRequestDepth = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
      .maxInProcessRequestDepth
  } = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
) {
  const failures = []
  if (samples.length < 2) {
    failures.push(`native status sampler returned ${samples.length} sample(s), expected at least 2`)
    return {
      failures,
      sampleCount: samples.length,
      maxFrameStallMs: 0,
      maxSampleGapMs: 0,
      droppedFrameDelta: 0,
      maxCompositorFrameLag: 0,
      maxHelperRequestDepth: 0
    }
  }

  let previous = samples[0]
  let currentFrame = presentedFrame(previous.status)
  let currentRunId = compositorRunId(previous.status)
  let compositorRunTransitions = 0
  let frameUnchangedSince = previous.at
  let maxFrameStallObservedMs = 0
  let maxSampleGapObservedMs = 0
  let maxLagObserved = finiteNumber(previous.status.compositorFrameLag) ?? 0
  let maxDepthObserved = finiteNumber(previous.status.pendingHostCommandCount) ?? 0

  for (const [index, sample] of samples.entries()) {
    const status = sample.status ?? {}
    const prefix = `sample ${index + 1}`
    if (status.state !== 'live') {
      failures.push(`${prefix} state ${status.state ?? 'missing'}, expected live`)
    }
    if (status.transport !== 'native-surface') {
      failures.push(`${prefix} transport ${status.transport ?? 'missing'}, expected native-surface`)
    }
    if (status.backing !== 'cametal-layer') {
      failures.push(`${prefix} backing ${status.backing ?? 'missing'}, expected cametal-layer`)
    }
    if (status.sourcePixelsPresent !== true) {
      failures.push(`${prefix} did not report source pixels present`)
    }

    const depth = finiteNumber(status.pendingHostCommandCount)
    if (depth !== null) {
      maxDepthObserved = Math.max(maxDepthObserved, depth)
      const inProcess = status.nativePreviewHostKind === 'in-process'
      const maxRequestDepth = inProcess ? maxInProcessRequestDepth : maxHelperRequestDepth
      if (depth > maxRequestDepth) {
        failures.push(
          `${prefix} ${inProcess ? 'in-process' : 'helper'} request depth ${depth} exceeded ${maxRequestDepth}`
        )
      }
    }

    const lag = finiteNumber(status.compositorFrameLag)
    if (lag !== null) {
      maxLagObserved = Math.max(maxLagObserved, lag)
      if (lag > maxCompositorFrameLag) {
        failures.push(`${prefix} compositor frame lag ${lag} exceeded ${maxCompositorFrameLag}`)
      }
    }

    if (index === 0) continue

    const gapMs = sample.at - previous.at
    maxSampleGapObservedMs = Math.max(maxSampleGapObservedMs, gapMs)
    const frame = presentedFrame(status)
    const runId = compositorRunId(status)
    if (runId !== null && currentRunId !== null && runId !== currentRunId) {
      // Frame ids are local to a compositor run. Layout/drawable changes may
      // replace that run without interrupting the native surface, so a new
      // run starting at frame 1 is forward progress rather than regression.
      compositorRunTransitions += 1
      currentRunId = runId
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else if (frame < currentFrame) {
      failures.push(`${prefix} presented frame moved backwards from ${currentFrame} to ${frame}`)
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else if (frame > currentFrame) {
      currentFrame = frame
      frameUnchangedSince = sample.at
    } else {
      maxFrameStallObservedMs = Math.max(maxFrameStallObservedMs, sample.at - frameUnchangedSince)
    }
    previous = sample
  }

  if (maxFrameStallObservedMs > maxFrameStallMs) {
    failures.push(
      `presented-frame stall ${maxFrameStallObservedMs}ms exceeded ${maxFrameStallMs}ms`
    )
  }
  if (maxSampleGapObservedMs > maxSampleGapMs) {
    failures.push(
      `native status sampling gap ${maxSampleGapObservedMs}ms exceeded ${maxSampleGapMs}ms`
    )
  }

  const firstDropped = finiteNumber(samples[0].status?.droppedFrames) ?? 0
  const lastDropped = finiteNumber(samples.at(-1).status?.droppedFrames) ?? firstDropped
  const droppedFrameDelta = Math.max(0, lastDropped - firstDropped)
  if (droppedFrameDelta > maxDroppedFrameDelta) {
    failures.push(`dropped-frame spike ${droppedFrameDelta} exceeded ${maxDroppedFrameDelta}`)
  }

  return {
    failures: unique(failures),
    sampleCount: samples.length,
    maxFrameStallMs: maxFrameStallObservedMs,
    maxSampleGapMs: maxSampleGapObservedMs,
    droppedFrameDelta,
    maxCompositorFrameLag: maxLagObserved,
    maxHelperRequestDepth: maxDepthObserved,
    compositorRunTransitions,
    firstPresentedFrame: presentedFrame(samples[0].status),
    lastPresentedFrame: presentedFrame(samples.at(-1).status)
  }
}

function compositorRunId(status) {
  return typeof status?.nativePreviewCompositorRunId === 'string' &&
    status.nativePreviewCompositorRunId.trim()
    ? status.nativePreviewCompositorRunId
    : null
}

export function analyzeCgWindowObservations(
  observations,
  {
    helperOwner = 'native_preview_host_helper',
    expectedHostKind = 'in-process',
    expectedWindowPid,
    maxSurfaceOffsetPx = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxSurfaceOffsetPx,
    requirePixelOracle = false,
    maxBlankBaseFraction = 0.9,
    minOracleCoverage = PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.minOracleCoverage
  } = {}
) {
  const failures = []
  const observedHostKinds = new Set()
  let inProcessSamples = 0
  let helperProcessSamples = 0
  let unexpectedHostKindSamples = 0
  let inProcessHelperWindowSamples = 0
  let inProcessHelperProcessSamples = 0
  let inProcessWindowCountMismatchSamples = 0
  let inProcessNonNormalLayerSamples = 0
  let helperMissingSamples = 0
  let baseMissingSamples = 0
  let zOrderGapSamples = 0
  let misalignedSamples = 0
  let maxSurfaceOffsetObservedPx = 0
  let pixelSampleCount = 0
  let darkPixelSamples = 0
  let blankBasePixelSamples = 0
  let eligibleObservationCount = 0
  let oracleObservedSamples = 0
  let oracleUnavailableSamples = 0

  for (const [index, observation] of observations.entries()) {
    const bounds = observation.expectedBounds
    const windows = observation.windows ?? []
    if (!bounds) continue
    eligibleObservationCount += 1
    if (observation.oracleObserved === false) {
      oracleUnavailableSamples += 1
      continue
    }
    oracleObservedSamples += 1
    const hostKind = observation.hostKind ?? 'missing'
    observedHostKinds.add(hostKind)
    if (hostKind !== expectedHostKind) unexpectedHostKindSamples += 1

    const helpers = windows.filter((window) => window.owner === helperOwner && window.alpha > 0)
    if (hostKind === 'in-process') {
      inProcessSamples += 1
      if (helpers.length > 0) inProcessHelperWindowSamples += 1
      const bases = findInProcessPreviewWindows(windows, expectedWindowPid)
      if (bases.length !== 1) {
        inProcessWindowCountMismatchSamples += 1
        if (bases.length === 0) baseMissingSamples += 1
      }
      const base = bases[0]
      if (base && base.layer !== 0) inProcessNonNormalLayerSamples += 1
      if (
        base &&
        helperDescendants(observation.processes ?? [], base.pid, helperOwner).length > 0
      ) {
        inProcessHelperProcessSamples += 1
      }
      if (finiteNumber(observation.pixel?.sampleCount) > 0) {
        pixelSampleCount += 1
        if ((finiteNumber(observation.pixel?.nonDarkFraction) ?? 0) < 0.01) {
          darkPixelSamples += 1
        }
        if ((finiteNumber(observation.pixel?.blankBaseFraction) ?? 0) >= maxBlankBaseFraction) {
          blankBasePixelSamples += 1
        }
      }
      // The CAMetalLayer is attached inside this one Electron NSView. There is
      // no second OS window whose placement can trail it, so OS-level offset is
      // exactly zero by construction; drawable bounds remain covered by the
      // native driver/unit gates.
      continue
    }

    if (hostKind === 'proof-surface') {
      continue
    }

    // The helper geometry/z-order oracle is transitional and runs only for an
    // explicit helper-process host (plus a missing host kind on the historical
    // pre-fix baseline, which is still rejected by expectedHostKind above).
    helperProcessSamples += 1
    const helper = helpers.sort(
      (left, right) => boundsError(left, bounds) - boundsError(right, bounds)
    )[0]
    if (!helper) {
      helperMissingSamples += 1
      continue
    }

    const surfaceOffset = boundsError(helper, bounds)
    maxSurfaceOffsetObservedPx = Math.max(maxSurfaceOffsetObservedPx, surfaceOffset)
    if (surfaceOffset > maxSurfaceOffsetPx) {
      misalignedSamples += 1
    }

    const base = findPreviewBaseWindows(windows, bounds, {
      excludedPid: helper.pid,
      requiredLayer: helper.layer
    })[0]
    if (!base) {
      baseMissingSamples += 1
      continue
    }
    if (helper.order >= base.order) {
      zOrderGapSamples += 1
      if (zOrderGapSamples <= 3) {
        failures.push(
          `CGWindow sample ${index + 1} placed helper order ${helper.order} behind preview base order ${base.order}`
        )
      }
    }
  }

  if (unexpectedHostKindSamples > 0) {
    failures.push(
      `native preview host kind was ${[...observedHostKinds].join(', ')}, expected ${expectedHostKind} in ${unexpectedHostKindSamples}/${observations.length} sample(s)`
    )
  }
  const oracleCoverage =
    eligibleObservationCount > 0 ? oracleObservedSamples / eligibleObservationCount : 0
  if (oracleCoverage < minOracleCoverage) {
    failures.push(
      `CGWindow oracle coverage ${formatPercent(oracleCoverage)} was below ${formatPercent(minOracleCoverage)} (${oracleObservedSamples}/${eligibleObservationCount} fresh sample(s))`
    )
  }
  if (inProcessHelperWindowSamples > 0) {
    failures.push(
      `in-process host exposed 1 helper CGWindow or more in ${inProcessHelperWindowSamples}/${inProcessSamples} sample(s)`
    )
  }
  if (inProcessHelperProcessSamples > 0) {
    failures.push(
      `in-process host spawned native_preview_host_helper in ${inProcessHelperProcessSamples}/${inProcessSamples} sample(s)`
    )
  }
  if (inProcessWindowCountMismatchSamples > 0) {
    failures.push(
      `in-process host did not resolve to exactly one Electron preview window in ${inProcessWindowCountMismatchSamples}/${inProcessSamples} sample(s)`
    )
  }
  // The preview's one Electron window legitimately changes CGWindow levels
  // when the always-on-top preference is exercised. Atomic ownership is the
  // invariant: exactly one Electron window and no helper window/process.
  if (requirePixelOracle && pixelSampleCount === 0) {
    failures.push('pixel oracle returned no preview-region samples in device mode')
  }
  if (requirePixelOracle && blankBasePixelSamples > 0) {
    failures.push(
      `pixel oracle observed the preview base in ${blankBasePixelSamples}/${pixelSampleCount} sample(s)`
    )
  }

  if (helperMissingSamples > 0) {
    failures.push(
      `CGWindow oracle missed the native helper in ${helperMissingSamples}/${observations.length} sample(s)`
    )
  }
  if (baseMissingSamples > 0) {
    failures.push(
      `CGWindow oracle could not identify the Electron preview base in ${baseMissingSamples}/${observations.length} sample(s)`
    )
  }
  if (misalignedSamples > 0) {
    failures.push(
      `native helper exceeded ${maxSurfaceOffsetPx}px alignment tolerance in ${misalignedSamples}/${observations.length} sample(s); max offset ${maxSurfaceOffsetObservedPx}px`
    )
  }
  if (zOrderGapSamples > 0) {
    failures.push(
      `native helper fell behind the Electron preview base in ${zOrderGapSamples}/${observations.length} sample(s)`
    )
  }

  return {
    failures: unique(failures),
    observationCount: observations.length,
    oracleObservedSamples,
    oracleUnavailableSamples,
    oracleCoverage,
    observedHostKinds: [...observedHostKinds],
    expectedHostKind,
    inProcessSamples,
    helperProcessSamples,
    unexpectedHostKindSamples,
    inProcessHelperWindowSamples,
    inProcessHelperProcessSamples,
    inProcessWindowCountMismatchSamples,
    inProcessNonNormalLayerSamples,
    pixelSampleCount,
    darkPixelSamples,
    blankBasePixelSamples,
    helperMissingSamples,
    baseMissingSamples,
    misalignedSamples,
    zOrderGapSamples,
    maxSurfaceOffsetPx: maxSurfaceOffsetObservedPx
  }
}

export function cgOraclePreviewReady(
  sample,
  {
    hostKind,
    helperOwner = 'native_preview_host_helper',
    expectedWindowPid,
    requirePixels = false,
    maxBlankBaseFraction = 0.9
  }
) {
  if (!sample) return false
  const windows = sample.windows ?? []
  const hostReady =
    hostKind === 'in-process'
      ? findInProcessPreviewWindows(windows, expectedWindowPid).length === 1
      : hostKind === 'helper-process'
        ? windows.some((window) => window.owner === helperOwner && window.alpha > 0)
        : false
  if (!hostReady) return false
  if (!requirePixels) return true
  return (
    (finiteNumber(sample.pixel?.sampleCount) ?? 0) > 0 &&
    (finiteNumber(sample.pixel?.blankBaseFraction) ?? 1) < maxBlankBaseFraction
  )
}

function findInProcessPreviewWindows(windows, expectedWindowPid) {
  const expectedPid = finiteNumber(expectedWindowPid)
  return windows.filter((window) => {
    const owner = String(window.owner ?? '').toLowerCase()
    const name = String(window.name ?? '').toLowerCase()
    return (
      window.alpha > 0 &&
      (expectedPid === null || window.pid === expectedPid) &&
      name.includes('videorc preview') &&
      (owner.includes('electron') || owner.includes('videorc'))
    )
  })
}

function findPreviewBaseWindows(
  windows,
  bounds,
  { excludedPid = null, requiredLayer = null } = {}
) {
  const expectedArea = Math.max(1, bounds.width * bounds.height)
  const candidates = windows.filter((window) => {
    if (
      window.pid === excludedPid ||
      (requiredLayer !== null && window.layer !== requiredLayer) ||
      window.alpha <= 0 ||
      !looksLikeVideorcWindow(window)
    ) {
      return false
    }
    return containsBounds(window, bounds, 90) && windowArea(window) <= expectedArea * 1.75
  })
  return candidates.sort((left, right) => windowArea(left) - windowArea(right))
}

function helperDescendants(processes, rootPid, helperOwner) {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const process of processes) {
      if (descendants.has(process.ppid) && !descendants.has(process.pid)) {
        descendants.add(process.pid)
        changed = true
      }
    }
  }
  return processes.filter(
    (process) =>
      descendants.has(process.pid) &&
      String(process.command ?? '')
        .split('/')
        .at(-1) === helperOwner
  )
}

function looksLikeVideorcWindow(window) {
  const owner = String(window.owner ?? '').toLowerCase()
  const name = String(window.name ?? '').toLowerCase()
  return owner.includes('electron') || owner.includes('videorc') || name.includes('videorc')
}

function containsBounds(window, bounds, margin) {
  return (
    window.x <= bounds.x + margin &&
    window.y <= bounds.y + margin &&
    window.x + window.width >= bounds.x + bounds.width - margin &&
    window.y + window.height >= bounds.y + bounds.height - margin
  )
}

function windowArea(window) {
  return Math.max(0, window.width) * Math.max(0, window.height)
}

function boundsError(actual, expected) {
  return Math.max(
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height)
  )
}

function presentedFrame(status) {
  return finiteNumber(status?.presentedFrameId) ?? finiteNumber(status?.framesRendered) ?? -1
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatPercent(value) {
  return `${(Math.max(0, value) * 100).toFixed(1)}%`
}

function unique(values) {
  return [...new Set(values)]
}
