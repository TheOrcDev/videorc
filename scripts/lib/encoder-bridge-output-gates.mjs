const VIDEO_TOOLBOX_OUTPUT_ALIASES = new Set([
  'videotoolbox-h264',
  'h264',
  'annex-b',
  'annexb',
  'videotoolbox-h264-mpegts',
  'h264-mpegts',
  'mpegts',
  'mpeg-ts'
])

const RAW_YUV_OUTPUT_ALIASES = new Set(['raw', 'raw-yuv420p', 'raw_yuv420p', 'rawvideo', 'yuv420p'])

// The Windows Media Foundation bridge has no VideoToolbox or Metal stage; its
// output is gated by the Windows D3D11 diagnostics instead.
const WINDOWS_MEDIA_FOUNDATION_OUTPUT = 'windows-media-foundation-h264-mpegts'

export function normalizeEncoderBridgeVideoOutput(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
  if (RAW_YUV_OUTPUT_ALIASES.has(normalized)) {
    return 'raw-yuv420p'
  }
  if (normalized === WINDOWS_MEDIA_FOUNDATION_OUTPUT) {
    return WINDOWS_MEDIA_FOUNDATION_OUTPUT
  }
  if (VIDEO_TOOLBOX_OUTPUT_ALIASES.has(normalized) || normalized === '') {
    return 'videotoolbox-h264'
  }
  return 'videotoolbox-h264'
}

export function assertEncoderBridgeVideoOutputHealthy({ scenarioLabel, stats, videoOutput }) {
  if (normalizeEncoderBridgeVideoOutput(videoOutput) !== 'videotoolbox-h264') {
    return
  }

  const prefix = scenarioLabel ? `[${scenarioLabel}] ` : ''
  const rawCopied = count(stats.maxEncoderBridgeRawVideoCopiedFrames)
  const metalCopied = count(stats.maxEncoderBridgeMetalTargetCopiedFrames)
  const metalTargets = count(stats.maxEncoderBridgeMetalTargetFrames)
  const metalHandles = count(stats.maxEncoderBridgeMetalTargetHandleFrames)
  const zeroCopy = count(stats.maxEncoderBridgeZeroCopyFrames)
  const outputFrames = count(stats.maxEncoderBridgeVideoToolboxOutputFrames)
  const outputBytes = count(stats.maxEncoderBridgeVideoToolboxOutputBytes)
  const outputErrors = count(stats.maxEncoderBridgeVideoToolboxProbeErrors)

  if (rawCopied > 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output copied ${rawCopied} raw-YUV frame(s).`)
  }
  if (metalCopied > 0) {
    throw new Error(
      `${prefix}VideoToolbox H.264 output copied ${metalCopied} Metal-target frame(s) through the raw-video path.`
    )
  }
  if (metalHandles <= 0) {
    throw new Error(
      `${prefix}VideoToolbox H.264 output never received retained Metal target handles.`
    )
  }
  if (metalTargets > metalHandles) {
    throw new Error(
      `${prefix}VideoToolbox H.264 output had ${metalTargets - metalHandles} IOSurface-backed Metal target frame(s) without retained target handles.`
    )
  }
  if (zeroCopy <= 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output produced no zero-copy encoder frames.`)
  }
  if (outputFrames <= 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output produced no Annex B frames.`)
  }
  if (outputBytes <= 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output produced no encoded bytes.`)
  }
  if (zeroCopy < outputFrames) {
    throw new Error(
      `${prefix}VideoToolbox H.264 output reported ${outputFrames} Annex B frame(s) but only ${zeroCopy} zero-copy frame(s).`
    )
  }
  if (outputErrors > 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output reported ${outputErrors} encode error(s).`)
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
