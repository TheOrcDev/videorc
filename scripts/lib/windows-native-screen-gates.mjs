export function selectNativeWindowsScreen(devices) {
  const available = devices.filter(
    (device) => device.kind === 'screen' && device.status === 'available'
  )
  return (
    available.find((device) => /^screen:dxgi:[0-9a-f]+:\d+$/i.test(device.id)) ??
    available.find((device) => device.id === 'screen:gdigrab:desktop') ??
    null
  )
}

export function parseWindowsNativeScreenArgs(argv = []) {
  const values = [...(argv[0] === '--' ? argv.slice(1) : argv)]
  const d3d11 = takeFlag(values, '--d3d11')
  const requireD3d11 = takeFlag(values, '--require-d3d11')
  const expectFallback = takeOption(values, '--expect-fallback')
  // #1067: record a screen scene over the bundled background, so a session
  // with a background proves the D3D11 path (with --require-d3d11) and the
  // background on its first frame.
  const background = takeFlag(values, '--background')
  // #1175: record the scene the renderer sends in scene edit mode, with the
  // screen moved off its preset place, so a moved source proves the D3D11
  // path and its placement from the first frame. Combines with --background.
  const sceneEdit = takeFlag(values, '--scene-edit')
  if (values.length > 0) {
    throw new Error(`Unknown Windows native-screen argument: ${values[0]}`)
  }
  if (requireD3d11 && !d3d11) {
    throw new Error('--require-d3d11 requires --d3d11.')
  }
  if (expectFallback !== undefined && expectFallback !== 'natural') {
    throw new Error(`--expect-fallback must be natural; received ${expectFallback}.`)
  }
  if (expectFallback === 'natural' && (d3d11 || requireD3d11)) {
    throw new Error('--expect-fallback natural cannot be combined with an explicit D3D11 path.')
  }
  return {
    d3d11,
    requireD3d11,
    expectFallback: expectFallback ?? null,
    background,
    sceneEdit
  }
}

/** #1175: where `--scene-edit` puts the screen: the right half, centred. */
export const SCENE_EDIT_SCREEN_TRANSFORM = Object.freeze({
  x: 0.5,
  y: 0.25,
  width: 0.5,
  height: 0.5,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
})

/** The backend's stage inset for screen-like sources over a background. */
export const SCENE_BACKGROUND_STAGE_INSET = 0.1

/**
 * The sample rectangles (in pixels of a `width`×`height` frame) a
 * `--scene-edit` recording is judged on: `uncovered` lies wholly outside the
 * moved screen, so it shows the canvas fill (the background, or black);
 * `covered` is the screen's box, inset by the same margin. The whole box, not
 * its middle: a desktop's middle is often one flat dark window, while its
 * taskbar, text and edges always vary.
 *
 * `stageInset` mirrors the backend's `scene_source_render_transform`: with a
 * background, a screen is placed in a stage inset by 10% on every side
 * (x' = inset + x * (1 - 2 * inset)), so pass `SCENE_BACKGROUND_STAGE_INSET`.
 */
export function sceneEditFrameRegions(
  width,
  height,
  { transform = SCENE_EDIT_SCREEN_TRANSFORM, stageInset = 0 } = {}
) {
  const margin = Math.round(Math.min(width, height) * 0.04)
  const stage = 1 - 2 * stageInset
  const box = {
    x0: (stageInset + transform.x * stage) * width,
    y0: (stageInset + transform.y * stage) * height,
    x1: (stageInset + (transform.x + transform.width) * stage) * width,
    y1: (stageInset + (transform.y + transform.height) * stage) * height
  }
  return {
    uncovered: {
      x0: margin,
      y0: margin,
      x1: Math.floor(box.x0) - margin,
      y1: height - 1 - margin
    },
    covered: {
      x0: Math.ceil(box.x0) + margin,
      y0: Math.ceil(box.y0) + margin,
      x1: Math.min(width - 1, Math.floor(box.x1) - margin),
      y1: Math.min(height - 1, Math.floor(box.y1) - margin)
    }
  }
}

export function windowsNativeScreenRequiresFinalDiagnostics({
  requireEncodedBridge = false,
  d3d11 = false,
  expectFallback = null
} = {}) {
  return requireEncodedBridge || d3d11 || Boolean(expectFallback)
}

const formatHoldMs = (value) => (Number.isFinite(value) ? value.toFixed(1) : '-')

/**
 * One line naming why the D3D11 texture pool ran short (#1042): which bucket ran
 * out, who held its slots then, and each consumer role's mean/max hold.
 * Returns null when the backend did not report the breakdown.
 */
export function describeTexturePoolPressure(pressure) {
  if (!pressure || typeof pressure !== 'object') return null
  const parts = [
    `bgra=${pressure.bgraExhaustions ?? 0}`,
    `nv12=${pressure.nv12Exhaustions ?? 0}`,
    `renderSkips=${pressure.renderPressureSkips ?? 0}`
  ]
  const holders = Object.entries(pressure.holders ?? {})
    .filter(([, count]) => count > 0)
    .map(([role, count]) => `${role}=${count}`)
  if (holders.length > 0) parts.push(`holders ${holders.join(',')}`)
  const holds = Object.entries(pressure.holds ?? {})
    .filter(([, hold]) => (hold?.releases ?? 0) > 0)
    .map(([role, hold]) => `${role} ${formatHoldMs(hold.meanMs)}/${formatHoldMs(hold.maxMs)}ms`)
  if (holds.length > 0) parts.push(`hold mean/max ${holds.join(', ')}`)
  return parts.join('; ')
}

export function evaluateWindowsNativeScreenD3d11Diagnostics(
  diagnostics,
  { requireOutput = false, expectFallback = null, requireZeroPoolPressure = false } = {}
) {
  const failures = []
  const media = diagnostics?.windowsD3d11Media
  if (!media || typeof media !== 'object') {
    return ['windowsD3d11Media diagnostics were missing']
  }
  if (expectFallback === 'natural') {
    if (media.state !== 'fallback') failures.push(`state=${media.state ?? 'missing'}`)
    if (media.captureBackend !== 'legacy-ffmpeg') {
      failures.push(`captureBackend=${media.captureBackend ?? 'missing'}`)
    }
    if (typeof media.fallbackReason !== 'string' || !media.fallbackReason.trim()) {
      failures.push('fallbackReason=missing')
    }
    return failures
  }

  if (media.state !== 'live') failures.push(`state=${media.state ?? 'missing'}`)
  if (media.captureBackend === 'legacy-ffmpeg' || !media.captureBackend) {
    failures.push(`captureBackend=${media.captureBackend ?? 'missing'}`)
  }
  if ((media.captureReadbackFrames ?? 0) !== 0) {
    failures.push(`captureReadbackFrames=${media.captureReadbackFrames}`)
  }
  if ((media.compositorCpuFallbackFrames ?? 0) !== 0) {
    failures.push(`compositorCpuFallbackFrames=${media.compositorCpuFallbackFrames}`)
  }
  if ((media.encoderSystemMemorySamples ?? 0) !== 0) {
    failures.push(`encoderSystemMemorySamples=${media.encoderSystemMemorySamples}`)
  }
  if ((media.rawVideoCopiedFrames ?? 0) !== 0) {
    failures.push(`rawVideoCopiedFrames=${media.rawVideoCopiedFrames}`)
  }
  if ((media.previewBmpRequests ?? 0) !== 0 || (media.previewBmpBytes ?? 0) !== 0) {
    failures.push(
      `BMP=${media.previewBmpRequests ?? 0} requests/${media.previewBmpBytes ?? 0} bytes`
    )
  }
  if ((media.adapterMismatches ?? 0) !== 0) {
    failures.push(`adapterMismatches=${media.adapterMismatches}`)
  }
  if (requireZeroPoolPressure && (media.texturePoolPressureEvents ?? 0) !== 0) {
    const detail = describeTexturePoolPressure(media.texturePoolPressure)
    failures.push(
      `texturePoolPressureEvents=${media.texturePoolPressureEvents}${detail ? ` (${detail})` : ''}`
    )
  }
  if (typeof media.fallbackReason === 'string' && media.fallbackReason.trim()) {
    failures.push(`fallbackReason=${media.fallbackReason}`)
  }
  if (requireOutput) {
    if (!(media.textureImportFrames > 0)) {
      failures.push(`textureImportFrames=${media.textureImportFrames ?? 0}`)
    }
    if (!(media.encoderGpuSamples > 0)) {
      failures.push(`encoderGpuSamples=${media.encoderGpuSamples ?? 0}`)
    }
  }
  return failures
}

export function nativeWindowsScreenCandidates(devices) {
  const selected = selectNativeWindowsScreen(devices)
  if (!selected) return []
  if (selected.id === 'screen:gdigrab:desktop') return [selected]
  return [
    selected,
    {
      id: 'screen:gdigrab:desktop',
      name: 'Desktop (gdigrab fallback)',
      kind: 'screen',
      status: 'available',
      detail: 'Windows gdigrab fallback used when DXGI Desktop Duplication cannot start.'
    }
  ]
}

function takeFlag(values, name) {
  const matches = values.reduce((count, value) => count + (value === name ? 1 : 0), 0)
  if (matches > 1) throw new Error(`${name} may be supplied only once.`)
  if (matches === 0) return false
  values.splice(values.indexOf(name), 1)
  return true
}

function takeOption(values, name) {
  const indexes = values
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0)
  if (indexes.length > 1) throw new Error(`${name} may be supplied only once.`)
  if (indexes.length === 0) return undefined
  const index = indexes[0]
  const value = values[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  values.splice(index, 2)
  return value
}

export function windowsNativeScreenPerformanceBudgetContext({
  metadata,
  scenario = 'windows-proof-recording',
  timing
} = {}) {
  return {
    scenario,
    hardwareClass: metadata?.hardwareClass ?? null,
    profileClass: metadata?.profileClass ?? null,
    buildMode: metadata?.buildMode ?? null,
    operatingSystem: metadata?.operatingSystem ?? null,
    timing: timing ?? null,
    candidatePayloadSha256: metadata?.packagePayload?.sha256 ?? null
  }
}

export function nativeWindowsScreenRecordingActive(evidence, sourceId) {
  const { diagnostics, compositor, recording } = evidence ?? {}
  const sourceEntry = diagnostics?.sourceRegistry?.entries?.find(
    (entry) => entry?.key?.kind === 'screen' && entry?.key?.id === sourceId
  )
  return (
    diagnostics?.activeOutputMode === 'record' &&
    recording?.state === 'recording' &&
    (nativeWindowsCompositorUsesScreen(compositor, sourceId) ||
      nativeWindowsD3d11MediaEncodingActive(diagnostics)) &&
    sourceEntry?.status === 'live'
  )
}

export function nativeWindowsD3d11MediaEncodingActive(diagnostics) {
  const media = diagnostics?.windowsD3d11Media
  return (
    diagnostics?.encoderBridgeEncodedOutputInputSubtype === 'NV12-D3D11' ||
    (media?.state === 'live' &&
      (media.encoderGpuSamples ?? 0) > 0 &&
      (media.encoderSystemMemorySamples ?? 0) === 0 &&
      (media.rawVideoCopiedFrames ?? 0) === 0)
  )
}

export function nativeWindowsCompositorUsesScreen(compositor, sourceId) {
  const visibleTakeover = compositor?.sceneSources?.some(
    (source) => source?.kind === 'screen-image' && source?.visible === true
  )
  const sceneSource = compositor?.sceneSources?.find(
    (source) =>
      source?.kind === 'screen' &&
      source?.deviceId === sourceId &&
      source?.visible === true &&
      source?.state === 'referenced'
  )
  const liveSource = compositor?.sources?.find(
    (source) =>
      source?.kind === 'screen' &&
      source?.sourceId === sourceId &&
      source?.state === 'live' &&
      Number.isSafeInteger(source?.sequence) &&
      source.sequence > 0
  )
  return (
    compositor?.state === 'live' &&
    compositor?.sceneLayout?.layoutPreset === 'screen-only' &&
    compositor?.sceneRevision != null &&
    compositor?.frameSceneRevision === compositor.sceneRevision &&
    visibleTakeover !== true &&
    sceneSource != null &&
    liveSource != null
  )
}

export function assertWindowsGraphicsCaptureTexture(status) {
  if (status?.state !== 'live' || status?.d3d11TextureAvailable !== true) {
    throw new Error(
      `Windows Graphics Capture did not retain a D3D11 source texture: ${JSON.stringify(status)}`
    )
  }
  if (
    !Number.isSafeInteger(status.framesCaptured) ||
    status.framesCaptured < 1 ||
    !Number.isSafeInteger(status.actualWidth) ||
    status.actualWidth < 1 ||
    !Number.isSafeInteger(status.actualHeight) ||
    status.actualHeight < 1
  ) {
    throw new Error(
      `Windows Graphics Capture texture evidence is incomplete: ${JSON.stringify(status)}`
    )
  }
}

export function assertBmpHeaders(headers, status) {
  if (
    headers['x-videorc-frame-transport'] !== 'latest-bgra-bmp' ||
    typeof headers['x-videorc-frame-generation'] !== 'string' ||
    headers['x-videorc-frame-generation'].length === 0 ||
    !Number.isSafeInteger(Number(headers['x-videorc-frame-sequence'])) ||
    Number(headers['x-videorc-frame-sequence']) < 0
  ) {
    throw new Error(`BMP preview cursor/transport headers are invalid: ${JSON.stringify(headers)}`)
  }
  if (status !== 200) {
    return
  }
  for (const name of [
    'x-videorc-frame-width',
    'x-videorc-frame-height',
    'x-videorc-frame-stride',
    'x-videorc-pixel-format'
  ]) {
    if (!headers[name]) {
      throw new Error(`BMP preview response is missing ${name}.`)
    }
  }
  if (headers['content-type'] !== 'image/bmp' || headers['x-videorc-pixel-format'] !== 'bgra8') {
    throw new Error(`BMP preview response types are invalid: ${JSON.stringify(headers)}`)
  }
}

export function assertNonblankBmp(bytes, headers) {
  if (bytes.length < 58 || bytes.subarray(0, 2).toString('ascii') !== 'BM') {
    throw new Error(`BMP preview payload is invalid or truncated (${bytes.length} bytes).`)
  }
  const pixelOffset = bytes.readUInt32LE(10)
  const width = bytes.readInt32LE(18)
  const height = Math.abs(bytes.readInt32LE(22))
  const bitsPerPixel = bytes.readUInt16LE(28)
  if (
    width !== Number(headers['x-videorc-frame-width']) ||
    height !== Number(headers['x-videorc-frame-height']) ||
    bitsPerPixel !== 32 ||
    bytes.length < pixelOffset + width * height * 4
  ) {
    throw new Error(
      `BMP header/payload mismatch: width=${width}, height=${height}, bpp=${bitsPerPixel}, bytes=${bytes.length}.`
    )
  }
  const pixels = bytes.subarray(pixelOffset)
  let minimum = 255
  let maximum = 0
  const sampleCount = Math.min(1024, width * height)
  for (let index = 0; index < sampleCount; index += 1) {
    const pixelIndex = Math.floor((index * (width * height - 1)) / Math.max(1, sampleCount - 1)) * 4
    for (let channel = 0; channel < 3; channel += 1) {
      const value = pixels[pixelIndex + channel] ?? 0
      minimum = Math.min(minimum, value)
      maximum = Math.max(maximum, value)
    }
  }
  if (maximum - minimum < 8 || maximum < 16) {
    throw new Error(
      `BMP preview decoded as blank/constant: range=${maximum - minimum}, max=${maximum}.`
    )
  }
}

export function requiredBmpPreviewAdvances(screen) {
  // GitHub-hosted Windows runners expose the Microsoft Basic Render Driver,
  // which has no physical compositor/GPU cadence. Keep proving that the BMP
  // surface advances through recording, but do not apply the physical-GPU
  // five-frame expectation to this explicitly identified software renderer.
  return /microsoft basic render driver/i.test(screen?.detail ?? '') ? 3 : 5
}

export function windowsNativeScreenRecordingArtifactGates(screen) {
  const hostedSoftwareRenderer = /microsoft basic render driver/i.test(screen?.detail ?? '')
  return {
    requireMotion: false,
    ...(hostedSoftwareRenderer
      ? {
          // The hosted Basic Render Driver consistently records around
          // 29.25fps for a requested 30fps session. Keep artifact proof
          // strict on real GPUs while allowing that documented software-host
          // floor (5% still catches material drops or cadence regressions).
          frameCountTolerance: 0.05,
          cadenceMismatchTolerancePct: 5
        }
      : {})
  }
}
