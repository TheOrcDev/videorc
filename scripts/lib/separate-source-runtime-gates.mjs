import { toneAmplitude } from './separate-source-take-gates.mjs'
// Content alignment, independent of container start_time and duration.
export function videoTransitionTimes(rgb, { timestamps, channel }) {
  if (timestamps.length !== rgb.length / 3 || timestamps.some((at) => !Number.isFinite(at))) {
    throw new Error('Decoded pixels must have one finite media timestamp per frame')
  }
  const times = []
  for (let index = 3; index + 2 < rgb.length; index += 3) {
    if (Math.abs(rgb[index + channel] - rgb[index - 3 + channel]) > 35) {
      times.push(timestamps[index / 3])
    }
  }
  return times
}

export function evaluateEventAlignment(events, fps) {
  const failures = []
  const reference = events.screen ?? []
  const toleranceSeconds = 1 / fps + 0.01
  if (reference.length < 3) failures.push('screen has fewer than three changing content events')
  for (const role of ['combined', 'camera']) {
    const actual = events[role] ?? []
    if (actual.length !== reference.length) {
      failures.push(`${role} has ${actual.length} events; screen has ${reference.length}`)
      continue
    }
    for (let index = 0; index < reference.length; index += 1) {
      if (Math.abs(actual[index] - reference[index]) > toleranceSeconds) {
        failures.push(`${role} event ${index} is outside one frame plus 10ms`)
      }
    }
  }
  return { pass: failures.length === 0, failures, toleranceSeconds }
}

export function audioEnergyTransitions(pcm, { sampleRate = 48000, startTime = 0 } = {}) {
  const window = Math.round(sampleRate / 100)
  const events = []
  let previous
  for (let offset = 0; offset + window <= pcm.length; offset += window) {
    let squares = 0
    for (let index = offset; index < offset + window; index++) squares += pcm[index] ** 2
    const audible = Math.sqrt(squares / window) > 0.08
    if (previous !== undefined && audible !== previous) events.push(startTime + offset / sampleRate)
    previous = audible
  }
  return events
}

export function evaluateAudioVideoEvents(
  video,
  audio,
  { fps, offsetMs = 0, endSeconds = Infinity }
) {
  const tolerance = 1 / fps + 0.01
  const checked = video
    .map((at) => at + offsetMs / 1000)
    .filter((at) => at > 0.2 && at < endSeconds - tolerance)
  const failures = []
  if (checked.length < 3) failures.push('fewer than three interior audio/video events')
  const actual = audio.filter(
    (at) => at >= checked[0] - tolerance && at <= checked.at(-1) + tolerance
  )
  if (actual.length !== checked.length)
    failures.push(`audio has ${actual.length} ordered events; expected ${checked.length}`)
  for (const [index, at] of checked.entries()) {
    if (!(Math.abs(actual[index] - at) <= tolerance))
      failures.push(`audio misses ordered video event ${index} at ${at.toFixed(3)}s`)
  }
  return { pass: failures.length === 0, failures }
}

// Every source publishes the same modulo-32 blue marker at 100Hz. It changes
// even between pulse edges, exposing late first content and held frames.
export function evaluateFrameMarkers(frames, fps) {
  const failures = []
  const reference = frames.screen ?? []
  const allowance = Math.ceil((1 / fps + 0.01) * 100) * 6 + 4
  for (const role of ['camera', 'combined']) {
    const actual = frames[role] ?? []
    if (!actual.length || !reference.length) {
      failures.push(`${role} has no decoded frame markers`)
      continue
    }
    for (const [index, frame] of actual.entries()) {
      const matching =
        index === 0
          ? reference[0]
          : reference.reduce((best, candidate) =>
              Math.abs(candidate.time - frame.time) < Math.abs(best.time - frame.time)
                ? candidate
                : best
            )
      if (Math.abs(matching.time - frame.time) > 1 / fps + 0.01) {
        failures.push(`${role} frame ${index} timestamp differs from the shared timeline`)
        continue
      }
      const distance = Math.abs(frame.value - matching.value)
      if (Math.min(distance, 192 - distance) > allowance) {
        failures.push(`${role} frame ${index} content marker differs at ${frame.time.toFixed(3)}s`)
      }
    }
  }
  return { pass: failures.length === 0, failures }
}

export function audioToneWindows(pcm, { frequency, sampleRate = 48000, startTime = 0 }) {
  const window = Math.round(sampleRate / 100)
  const windows = []
  for (let offset = 0; offset + window <= pcm.length; offset += window) {
    windows.push({
      time: startTime + offset / sampleRate,
      amplitude: toneAmplitude(pcm.subarray(offset, offset + window), {
        frequency,
        sampleRate,
        channels: 1
      })
    })
  }
  return windows
}

export function toneWindowTransitions(windows) {
  const threshold = Math.max(0.01, Math.max(...windows.map((window) => window.amplitude)) / 2)
  return windows
    .filter(
      (window, index) =>
        index > 0 && window.amplitude > threshold !== windows[index - 1].amplitude > threshold
    )
    .map((window) => window.time)
}

export function evaluateAudioTail(reference, actual, fps = 30) {
  const end = reference.at(-1)?.time ?? 0
  const tolerance = 1 / fps + 0.01
  const failures = []
  if (!reference.length || !actual.length || (actual.at(-1)?.time ?? 0) + tolerance < end) {
    failures.push('role audio does not cover the required reference stop boundary')
    return { pass: false, failures }
  }
  const checked = reference.filter(
    (window) => window.time > end - 0.3 && window.time < end - tolerance
  )
  if (checked.length < 10) failures.push('insufficient measured stop audio windows')
  for (const window of checked) {
    const matching = actual.reduce((best, candidate) =>
      Math.abs(candidate.time - window.time) < Math.abs(best.time - window.time) ? candidate : best
    )
    if (
      Math.abs(matching.time - window.time) > tolerance ||
      Math.abs(matching.amplitude - window.amplitude) > 0.06
    ) {
      failures.push(`required stop audio differs at ${window.time.toFixed(3)}s`)
    }
  }
  return { pass: failures.length === 0, failures }
}

export function maximumToneAmplitude(pcm, frequency) {
  let maximum = 0
  for (let offset = 0; offset + 4800 <= pcm.length; offset += 4800) {
    maximum = Math.max(
      maximum,
      toneAmplitude(pcm.subarray(offset, offset + 4800), { frequency, channels: 1 })
    )
  }
  return maximum
}

// Compare the entire source-clock envelope, including the last available
// samples. Container duration and two equally truncated outputs cannot pass.
export function evaluateSourceEnvelope(video, audio, { fps, offsetMs = 0, endSeconds }) {
  const tolerance = 1 / fps + 0.01
  const offset = offsetMs / 1000
  const failures = []
  const transitions = video
    .filter((frame, index) => index && frame.hot !== video[index - 1].hot)
    .map((frame) => frame.time)
  if (!audio.length || audio.at(-1).time + 0.01 < endSeconds - tolerance)
    failures.push('audio does not cover the source-removal or Stop-request boundary')
  let checked = 0
  for (const window of audio) {
    if (window.time < 0.2 || window.time >= endSeconds - tolerance) continue
    const sourceTime = window.time - offset
    if (
      sourceTime < 0.2 ||
      Math.abs(sourceTime - endSeconds) <= tolerance ||
      transitions.some((at) => Math.abs(sourceTime - at) <= tolerance)
    )
      continue
    const source = video.findLast((frame) => frame.time <= sourceTime)
    const hot = sourceTime < endSeconds && source?.hot
    if (window.amplitude > 0.04 !== Boolean(hot))
      failures.push(`source envelope differs at ${window.time.toFixed(3)}s`)
    checked++
  }
  if (checked < 20) failures.push('insufficient source-clock samples')
  return { pass: !failures.length, failures, checked }
}
