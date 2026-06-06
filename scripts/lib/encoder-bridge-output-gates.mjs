const VIDEO_TOOLBOX_OUTPUT_ALIASES = new Set(['videotoolbox-h264', 'h264', 'annex-b', 'annexb'])

export function normalizeEncoderBridgeVideoOutput(value) {
  const normalized = String(value ?? 'raw-yuv420p')
    .trim()
    .toLowerCase()
  return VIDEO_TOOLBOX_OUTPUT_ALIASES.has(normalized) ? 'videotoolbox-h264' : 'raw-yuv420p'
}

export function assertEncoderBridgeVideoOutputHealthy({ scenarioLabel, stats, videoOutput }) {
  if (normalizeEncoderBridgeVideoOutput(videoOutput) !== 'videotoolbox-h264') {
    return
  }

  const prefix = scenarioLabel ? `[${scenarioLabel}] ` : ''
  const rawCopied = count(stats.maxEncoderBridgeRawVideoCopiedFrames)
  const metalCopied = count(stats.maxEncoderBridgeMetalTargetCopiedFrames)
  const metalHandles = count(stats.maxEncoderBridgeMetalTargetHandleFrames)
  const zeroCopy = count(stats.maxEncoderBridgeZeroCopyFrames)
  const outputFrames = count(stats.maxEncoderBridgeVideoToolboxOutputFrames)
  const outputBytes = count(stats.maxEncoderBridgeVideoToolboxOutputBytes)
  const outputErrors = count(stats.maxEncoderBridgeVideoToolboxProbeErrors)

  if (rawCopied > 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output copied ${rawCopied} raw-YUV frame(s).`)
  }
  if (metalCopied > 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output copied ${metalCopied} Metal-target frame(s) through the raw-video path.`)
  }
  if (metalHandles <= 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output never received retained Metal target handles.`)
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
    throw new Error(`${prefix}VideoToolbox H.264 output reported ${outputFrames} Annex B frame(s) but only ${zeroCopy} zero-copy frame(s).`)
  }
  if (outputErrors > 0) {
    throw new Error(`${prefix}VideoToolbox H.264 output reported ${outputErrors} encode error(s).`)
  }
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
