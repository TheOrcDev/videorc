const TRANSPORT_STRENGTH = [
  'd3d11-shared-texture',
  'native-surface',
  'electron-proof-surface',
  'live-mjpeg',
  'live-jpeg',
  'image-poll',
  'unavailable'
]

const BACKING_STRENGTH = [
  'directcomposition-swapchain',
  'cametal-layer',
  'electron-browser-window',
  'none'
]

export function claimsNativePreview({
  previewTransport,
  diagnostics = {},
  platform = process.platform
}) {
  const transports = new Set(
    [
      previewTransport,
      ...(Array.isArray(diagnostics.transports) ? diagnostics.transports : [])
    ].filter(Boolean)
  )
  const backings = new Set(
    [
      diagnostics.previewSurfaceBacking,
      ...(Array.isArray(diagnostics.surfaceBackings) ? diagnostics.surfaceBackings : [])
    ].filter(Boolean)
  )
  const hostKinds = new Set(
    [
      diagnostics.nativePreviewHostKind,
      ...(Array.isArray(diagnostics.nativePreviewHostKinds)
        ? diagnostics.nativePreviewHostKinds
        : [])
    ].filter(Boolean)
  )

  if (platform === 'darwin') {
    return transports.has('native-surface') && backings.has('cametal-layer')
  }
  if (platform === 'win32') {
    return (
      transports.has('d3d11-shared-texture') &&
      backings.has('directcomposition-swapchain') &&
      hostKinds.has('backend-d3d11-presenter')
    )
  }
  return false
}

export function formatTransportHonesty({
  previewTransport,
  diagnostics = {},
  platform = process.platform
}) {
  const imagePolls = diagnostics.imagePollDuringSession?.total ?? 0
  if (claimsNativePreview({ previewTransport, diagnostics, platform })) {
    return imagePolls === 0
      ? 'native (0 image polls)'
      : `NOT native (${imagePolls} image polls during native preview claim)`
  }

  const backing =
    strongestPreviewBacking([
      diagnostics.previewSurfaceBacking,
      ...(Array.isArray(diagnostics.surfaceBackings) ? diagnostics.surfaceBackings : [])
    ]) ?? 'unknown backing'
  const transports =
    Array.isArray(diagnostics.transports) && diagnostics.transports.length
      ? diagnostics.transports.join(', ')
      : (previewTransport ?? 'unknown transport')
  return `NOT native (${transports}; ${backing}; ${imagePolls} image polls)`
}

export function strongestPreviewTransport(values) {
  return strongestPreviewValue(values, TRANSPORT_STRENGTH)
}

export function strongestPreviewBacking(values) {
  return strongestPreviewValue(values, BACKING_STRENGTH)
}

function strongestPreviewValue(values, priority) {
  const observed = new Set((values ?? []).filter(Boolean))
  return priority.find((value) => observed.has(value)) ?? null
}
