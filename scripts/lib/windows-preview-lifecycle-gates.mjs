export function parseWindowsPreviewLifecycleMode(argv = [], env = process.env) {
  const values = [...argv]
  for (const performanceFlag of ['--gate', '--report-only']) {
    const index = values.indexOf(performanceFlag)
    if (index >= 0) values.splice(index, 1)
  }
  let expectFallback = false
  const fallbackIndex = values.indexOf('--expect-fallback')
  if (fallbackIndex >= 0) {
    if (values.indexOf('--expect-fallback', fallbackIndex + 1) >= 0) {
      throw new Error('--expect-fallback may be supplied only once.')
    }
    const value = values[fallbackIndex + 1]
    if (value !== 'natural') {
      throw new Error('--expect-fallback requires the value natural.')
    }
    values.splice(fallbackIndex, 2)
    expectFallback = true
  }
  if (values.length > 0) {
    throw new Error(`Unknown preview-lifecycle argument: ${values[0]}`)
  }
  const expectD3d11 = env.VIDEORC_EXPECT_WINDOWS_D3D11 === '1'
  if (expectD3d11 && expectFallback) {
    throw new Error('Windows D3D11 and natural-fallback preview modes are mutually exclusive.')
  }
  return expectD3d11 ? 'windows-d3d11' : expectFallback ? 'windows-fallback' : 'default'
}

export function windowsPreviewLifecycleOpenFailures(state, mode) {
  if (mode === 'default') {
    return state?.framePollingSuppressedFlag === false ? [] : ['frame polling did not resume']
  }

  const status = state?.surfaceStatus ?? {}
  if (mode === 'windows-fallback') {
    const failures = []
    if (status.transport !== 'electron-proof-surface') {
      failures.push(`transport=${status.transport ?? 'missing'}`)
    }
    if (status.backing !== 'electron-browser-window') {
      failures.push(`backing=${status.backing ?? 'missing'}`)
    }
    if (status.nativePreviewHostKind !== 'proof-surface') {
      failures.push(`host=${status.nativePreviewHostKind ?? 'missing'}`)
    }
    if (status.firstFrameContract !== 'fallback') {
      failures.push(`firstFrameContract=${status.firstFrameContract ?? 'missing'}`)
    }
    if (typeof status.firstFrameReason !== 'string' || !status.firstFrameReason.trim()) {
      failures.push('fallback reason missing')
    }
    if (state?.surface?.exists !== true || state?.surface?.visible !== true) {
      failures.push('Electron proof surface is not visible')
    }
    if (state?.framePollingSuppressedFlag !== false) {
      failures.push('proof frame polling is suppressed')
    }
    return failures
  }

  const failures = []
  if (status.transport !== 'd3d11-shared-texture') {
    failures.push(`transport=${status.transport ?? 'missing'}`)
  }
  if (status.backing !== 'directcomposition-swapchain') {
    failures.push(`backing=${status.backing ?? 'missing'}`)
  }
  if (status.nativePreviewHostKind !== 'backend-d3d11-presenter') {
    failures.push(`host=${status.nativePreviewHostKind ?? 'missing'}`)
  }
  if (status.firstFrameContract !== 'met' || status.sourcePixelsPresent !== true) {
    failures.push(
      `firstFrame=${status.firstFrameContract ?? 'missing'}/sourcePixels=${String(status.sourcePixelsPresent)}`
    )
  }
  if (state?.nativeOwnsPlacement !== true) {
    failures.push('backend presenter does not own placement')
  }
  if (state?.surface?.exists === true || state?.surface?.visible === true) {
    failures.push('Electron proof surface still exists')
  }
  if (state?.framePollingSuppressedFlag !== true || status.framePollingSuppressed !== true) {
    failures.push('BMP/proof polling is not suppressed')
  }
  failures.push(...windowsPreviewPresenterFailures(state))
  return failures
}

export function windowsPreviewPresenterFailures(
  state,
  { previousPresentedSequence, boundsTolerance = 4 } = {}
) {
  const presenter = state?.surfaceStatus?.windowsD3d11Presenter
  if (!presenter || typeof presenter !== 'object') {
    return ['Windows D3D11 presenter diagnostics are missing']
  }
  const failures = []
  for (const field of [
    'layered',
    'transparent',
    'noActivate',
    'excludedFromCapture',
    'generationMatches',
    'ownerProcessMatches',
    'sameAdapter',
    'sourceLive',
    'firstPresentSucceeded'
  ]) {
    if (presenter[field] !== true) failures.push(`presenter ${field}=false`)
  }
  for (const field of ['windowActive', 'windowFocused']) {
    if (presenter[field] !== false) failures.push(`presenter ${field}=true`)
  }
  if (!(presenter.successfulPresents > 0)) {
    failures.push(`presenter successfulPresents=${presenter.successfulPresents ?? 0}`)
  }
  if (!Number.isSafeInteger(presenter.lastPresentedSequence)) {
    failures.push('presenter lastPresentedSequence is missing')
  } else if (
    Number.isSafeInteger(previousPresentedSequence) &&
    presenter.lastPresentedSequence <= previousPresentedSequence
  ) {
    failures.push(
      `presenter sequence ${presenter.lastPresentedSequence} did not advance beyond ${previousPresentedSequence}`
    )
  }
  if (typeof presenter.fallbackReason === 'string' && presenter.fallbackReason.trim()) {
    failures.push(`presenter fallbackReason=${presenter.fallbackReason}`)
  }
  const expected = state?.contentBounds
  const actual = presenter.actualBounds
  if (!expected || !actual) {
    failures.push('presenter actual/content bounds are missing')
  } else {
    for (const field of ['x', 'y', 'width', 'height']) {
      if (
        !Number.isFinite(expected[field]) ||
        !Number.isFinite(actual[field]) ||
        Math.abs(expected[field] - actual[field]) > boundsTolerance
      ) {
        failures.push(
          `presenter ${field}=${actual[field] ?? 'missing'} did not match content ${field}=${expected[field] ?? 'missing'}`
        )
      }
    }
  }
  return failures
}

export function windowsPreviewLifecycleDiagnosticFailures(diagnostics, mode) {
  if (mode === 'default') return []
  const media = diagnostics?.windowsD3d11Media
  if (!media) return ['windowsD3d11Media diagnostics missing']
  if (mode === 'windows-fallback') {
    const failures = []
    if (media.state !== 'fallback') failures.push(`state=${media.state ?? 'missing'}`)
    if (typeof media.fallbackReason !== 'string' || !media.fallbackReason.trim()) {
      failures.push('fallbackReason=missing')
    }
    return failures
  }
  const failures = []
  if (media.state !== 'live') failures.push(`state=${media.state ?? 'missing'}`)
  if (!(media.previewPresents > 0)) {
    failures.push(`previewPresents=${media.previewPresents ?? 0}`)
  }
  if ((media.previewBmpRequests ?? 0) !== 0 || (media.previewBmpBytes ?? 0) !== 0) {
    failures.push(
      `BMP=${media.previewBmpRequests ?? 0} requests/${media.previewBmpBytes ?? 0} bytes`
    )
  }
  if (typeof media.fallbackReason === 'string' && media.fallbackReason.trim()) {
    failures.push(`fallbackReason=${media.fallbackReason}`)
  }
  return failures
}
