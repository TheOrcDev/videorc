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

export function nativeWindowsScreenRecordingActive(evidence, sourceId) {
  const { diagnostics, compositor, recording } = evidence ?? {}
  const sourceEntry = diagnostics?.sourceRegistry?.entries?.find(
    (entry) => entry?.key?.kind === 'screen' && entry?.key?.id === sourceId
  )
  return (
    diagnostics?.activeOutputMode === 'record' &&
    recording?.state === 'recording' &&
    nativeWindowsCompositorUsesScreen(compositor, sourceId) &&
    sourceEntry?.status === 'live'
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
