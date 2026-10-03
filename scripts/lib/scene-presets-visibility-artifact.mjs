// Every decoded frame is required: sampling a few frames cannot rule out a
// startup/rebuild camera flash. YMAX also catches a bright pixel within a frame.
export const VISIBILITY_BACKGROUND_MAX_LUMA = 32

export function parseVisibilityFrames(output) {
  const frames = []
  let current = null
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.e+-]+)$/)
    if (header) {
      current = { index: Number(header[1]), time: Number(header[2]), maxLuma: null }
      frames.push(current)
    }
    const value = line.match(/^lavfi\.signalstats\.YMAX=(\d+)$/)
    if (value && current) current.maxLuma = Number(value[1])
  }
  return frames
}

export function evaluateVisibilityArtifacts({
  visibleFrames,
  hiddenFrames,
  visibleCount,
  hiddenCount
}) {
  const failures = []
  for (const [role, frames, count] of [
    ['visible control', visibleFrames, visibleCount],
    ['hidden camera', hiddenFrames, hiddenCount]
  ]) {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      frames.length !== count ||
      frames.some(
        (frame, index) =>
          frame.index !== index ||
          !Number.isFinite(frame.time) ||
          frame.time < 0 ||
          !Number.isInteger(frame.maxLuma) ||
          frame.maxLuma < 0 ||
          frame.maxLuma > 255
      )
    ) {
      failures.push(`${role}: incomplete decoded-frame evidence`)
    }
  }
  if (!visibleFrames.some((frame) => frame.maxLuma > VISIBILITY_BACKGROUND_MAX_LUMA)) {
    failures.push(
      'visible control: camera pixels absent or too dark; visibility acceptance blocked'
    )
  }
  if (hiddenFrames.some((frame) => frame.maxLuma > VISIBILITY_BACKGROUND_MAX_LUMA)) {
    failures.push('hidden camera: foreground pixels in a decoded frame')
  }
  return {
    pass: failures.length === 0,
    failures,
    visibleFrames: visibleFrames.length,
    hiddenFrames: hiddenFrames.length
  }
}
