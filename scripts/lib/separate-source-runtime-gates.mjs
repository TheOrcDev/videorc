import { toneAmplitude } from './separate-source-take-gates.mjs'

// The runtime fixture's screen fills the canvas and its camera sits at bottom
// right. Circular markers must be sampled from one source, never averaged
// across sources whose counter values may straddle the modulo wrap.
export function combinedSourceMarkerFilter(layout) {
  if (
    layout?.layoutPreset !== 'screen-camera' ||
    layout.cameraTransformMode !== 'preset' ||
    layout.cameraCorner !== 'bottom-right' ||
    layout.cameraSize !== 'medium'
  )
    throw new Error('Combined marker ROI requires the declared screen-camera fixture layout')
  return 'crop=iw/4:ih/4:iw/8:ih/8,scale=1:1'
}
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
  { fps, offsetMs = 0, endSeconds = Infinity, measurement }
) {
  const tolerance = 1 / fps + 0.01
  const checked = video
    .map((at) => at + offsetMs / 1000)
    .filter((at) => at > 0.2 && at < endSeconds - tolerance)
  const failures = []
  if (checked.length < 3) failures.push('fewer than three interior audio/video events')
  if (measurement) {
    if (
      !Array.isArray(measurement.events) ||
      measurement.events.length !== audio.length ||
      measurement.events.some((at, index) => at !== audio[index]) ||
      !Array.isArray(measurement.diagnostics) ||
      !Array.isArray(measurement.failures)
    )
      throw new Error('Audio confidence must describe the complete supplied event measurement')
    const uncertain = measurement.diagnostics.filter((item) => !item.pass)
    // Precision applies to exactly the audio interval this ordered gate
    // already consumes. Keep startup/terminal diagnostics truthful without
    // requiring those unrelated transitions to have an interior-edge fit.
    // Missing evidence is global and cannot be qualified away by an interval.
    if (!measurement.pass && (!uncertain.length || measurement.failures.length > uncertain.length))
      failures.push('audio measurement has a global confidence failure')
    for (const item of uncertain) {
      const start = item.candidateIntervalStart
      const end = item.candidateIntervalEnd
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
        throw new Error('Audio confidence requires a finite ordered candidate interval')
      if (end >= checked[0] - tolerance && start <= checked.at(-1) + tolerance)
        failures.push(
          `audio edge confidence overlaps the checked interval at ${item.candidateTime.toFixed(6)}s`
        )
    }
  }
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
      endTime: startTime + (offset + window) / sampleRate,
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

// Solve the small normal equations used by the local sinusoid fits. Returning
// no fit is deliberate: an ill-conditioned measurement cannot establish sync.
function solveToneFit(matrix, values) {
  const rows = matrix.map((row, index) => [...row, values[index]])
  for (let column = 0; column < rows.length; column++) {
    let pivot = column
    for (let row = column + 1; row < rows.length; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row
    if (Math.abs(rows[pivot][column]) < 1e-8) return null
    ;[rows[column], rows[pivot]] = [rows[pivot], rows[column]]
    const scale = rows[column][column]
    for (let index = column; index <= rows.length; index++) rows[column][index] /= scale
    for (let row = 0; row < rows.length; row++) {
      if (row === column) continue
      const factor = rows[row][column]
      for (let index = column; index <= rows.length; index++)
        rows[row][index] -= factor * rows[column][index]
    }
  }
  return rows.map((row) => row.at(-1))
}

function localToneModel(pcm, frequencies, sampleRate, start, end) {
  const length = end - start
  const size = frequencies.length * 2 + 1
  const products = Array.from({ length: size * size }, () => new Float64Array(length + 1))
  const values = Array.from({ length: size }, () => new Float64Array(length + 1))
  let energy = 0
  for (let index = 0; index < length; index++) {
    const basis = frequencies.flatMap((frequency) => {
      const phase = (2 * Math.PI * frequency * index) / sampleRate
      return [Math.sin(phase), Math.cos(phase)]
    })
    basis.push(1)
    const sample = pcm[start + index]
    energy += sample * sample
    for (let row = 0; row < size; row++) {
      values[row][index + 1] = values[row][index] + basis[row] * sample
      for (let column = 0; column < size; column++) {
        const prefix = products[row * size + column]
        prefix[index + 1] = prefix[index] + basis[row] * basis[column]
      }
    }
  }
  return (cuts) => {
    const columns = frequencies.flatMap((_, index) => {
      const intervals =
        cuts[index] === null
          ? [[0, length]]
          : [
              [0, cuts[index]],
              [cuts[index], length]
            ]
      return intervals.flatMap(([from, to]) => [
        { basis: index * 2, from, to },
        { basis: index * 2 + 1, from, to }
      ])
    })
    columns.push({ basis: size - 1, from: 0, to: length })
    const rhs = columns.map(({ basis, from, to }) => values[basis][to] - values[basis][from])
    const matrix = columns.map((left) =>
      columns.map((right) => {
        const from = Math.max(left.from, right.from)
        const to = Math.min(left.to, right.to)
        const prefix = products[left.basis * size + right.basis]
        return to > from ? prefix[to] - prefix[from] : 0
      })
    )
    const coefficients = solveToneFit(matrix, rhs)
    if (!coefficients) return null
    return {
      coefficients,
      residual: Math.max(
        0,
        energy - coefficients.reduce((sum, value, index) => sum + value * rhs[index], 0)
      ),
      samples: length,
      parameters: columns.length
    }
  }
}

// Refine audio-only 10ms candidates against decoded samples. Each frequency
// has its own change point and sine/cosine coefficients, so neither phase nor
// a nearby transition of the other source decides the target's timing. No
// video timestamps or configured offsets enter this measurement. Events and
// diagnostic times are seconds on the decoded audio timeline.
export function refinedToneTransitions(
  pcm,
  { frequency, sampleRate = 48000, startTime = 0, interferingFrequencies = [317, 997] }
) {
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 100 ||
    !Number.isFinite(startTime) ||
    [frequency, ...interferingFrequencies].some(
      (value) => !Number.isFinite(value) || value <= 0 || value >= sampleRate / 2
    ) ||
    pcm.some((value) => !Number.isFinite(value))
  )
    throw new Error('Tone refinement requires finite mono PCM, frequencies and sample timing')
  const frequencies = [...new Set([frequency, ...interferingFrequencies])]
  const window = Math.round(sampleRate / 100)
  const candidates = frequencies.map((value, frequencyIndex) => {
    const windows = audioToneWindows(pcm, { frequency: value, sampleRate })
    const threshold = Math.max(0.01, Math.max(0, ...windows.map((item) => item.amplitude)) / 2)
    const states = windows.map((item) => item.amplitude > threshold)
    // A partial target edge can leak into the nuisance frequency for one
    // window. It is not evidence of a separate sustained nuisance tone.
    const stable =
      frequencyIndex === 0
        ? states
        : states.map((state, index) =>
            state === states[index - 1] || state === states[index + 1] ? state : !state
          )
    return windows.flatMap((_, index) =>
      index && stable[index] !== stable[index - 1]
        ? [{ sample: index * window, rising: stable[index] }]
        : []
    )
  })
  const events = []
  const diagnostics = []
  const failures = []
  if (!candidates[0].length) failures.push('no measurable target-tone transitions')
  for (const candidate of candidates[0]) {
    let start = Math.max(0, candidate.sample - window * 4)
    let end = Math.min(pcm.length, candidate.sample + window * 4)
    // Keep a distant nuisance edge outside the fit rather than using only a
    // fragment of its new state at the context boundary. Nearby edges retain
    // at least 10ms of samples on either side for their independent fit.
    for (const items of candidates.slice(1)) {
      for (const item of items) {
        if (item.sample >= candidate.sample + window * 3) end = Math.min(end, item.sample - window)
        if (item.sample <= candidate.sample - window * 3)
          start = Math.max(start, item.sample + window)
      }
    }
    const nearby = candidates.map((items) =>
      items.filter((item) => item.sample > start && item.sample < end)
    )
    const diagnostic = {
      candidateTime: startTime + candidate.sample / sampleRate,
      candidateIntervalStart: startTime + (candidate.sample - window) / sampleRate,
      candidateIntervalEnd: startTime + (candidate.sample + window) / sampleRate,
      frequency,
      rising: candidate.rising
    }
    const reject = (reason) => {
      diagnostics.push({ ...diagnostic, pass: false, reason })
      failures.push(`${frequency}Hz at ${diagnostic.candidateTime.toFixed(6)}s: ${reason}`)
    }
    if (nearby.some((items) => items.length > 1)) {
      reject('multiple nearby tone transitions cannot be isolated')
      continue
    }
    const cuts = nearby.map((items) => (items.length ? items[0].sample - start : null))
    const ranges = cuts.map((cut) =>
      cut === null
        ? null
        : [Math.max(window, cut - window), Math.min(end - start - window, cut + window)]
    )
    if (ranges.some((range) => range && range[0] >= range[1])) {
      reject('insufficient samples on both sides of the transition')
      continue
    }
    const model = localToneModel(pcm, frequencies, sampleRate, start, end)
    const stride = Math.max(1, Math.round(sampleRate / 8000))
    const optimize = (index) => {
      const [low, high] = ranges[index]
      let best = { cut: cuts[index], fit: model(cuts) }
      const inspect = (cut) => {
        cuts[index] = cut
        const fit = model(cuts)
        if (fit && (!best.fit || fit.residual < best.fit.residual)) best = { cut, fit }
      }
      for (let cut = low; cut <= high; cut += stride) inspect(cut)
      const coarse = best.cut
      for (let cut = Math.max(low, coarse - stride); cut <= Math.min(high, coarse + stride); cut++)
        inspect(cut)
      cuts[index] = best.cut
      return best.fit
    }
    const refine = () => {
      let fit
      for (let iteration = 0; iteration < 8; iteration++) {
        const previous = [...cuts]
        // Fit nuisance edges first, leaving the target as the final update.
        for (let index = 1; index < cuts.length; index++) if (cuts[index] !== null) optimize(index)
        fit = optimize(0)
        if (cuts.every((cut, index) => cut === previous[index])) return { fit, cuts: [...cuts] }
      }
      return null
    }
    let solution = refine()
    const changing = ranges
      .map((range, index) => (range ? index : null))
      .filter((index) => index !== null)
    if (changing.length > 1) {
      // Coincident tone edges have coupled minima. Also seed a common edge
      // from PCM, then let every frequency move independently again.
      const low = Math.max(...changing.map((index) => ranges[index][0]))
      const high = Math.min(...changing.map((index) => ranges[index][1]))
      let seed
      for (let cut = low; cut <= high; cut += stride) {
        for (const index of changing) cuts[index] = cut
        const fit = model(cuts)
        if (fit && (!seed || fit.residual < seed.fit.residual)) seed = { fit, cut }
      }
      if (seed) {
        const coarse = seed.cut
        for (
          let cut = Math.max(low, coarse - stride);
          cut <= Math.min(high, coarse + stride);
          cut++
        ) {
          for (const index of changing) cuts[index] = cut
          const fit = model(cuts)
          if (fit && fit.residual < seed.fit.residual) seed = { fit, cut }
        }
        for (const index of changing) cuts[index] = seed.cut
        const alternative = refine()
        if (alternative && (!solution || alternative.fit.residual < solution.fit.residual))
          solution = alternative
      }
    }
    if (!solution?.fit) {
      reject('local tone fit did not converge')
      continue
    }
    cuts.splice(0, cuts.length, ...solution.cuts)
    const fit = solution.fit
    const before = Math.hypot(fit.coefficients[0], fit.coefficients[1])
    const after = Math.hypot(fit.coefficients[2], fit.coefficients[3])
    const hot = Math.max(before, after)
    const residualRms = Math.sqrt(fit.residual / fit.samples)
    const bestCut = cuts[0]
    const noiseVariance = fit.residual / Math.max(1, fit.samples - fit.parameters)
    const indistinguishable = fit.residual + 9 * noiseVariance + hot * hot * 1e-8
    let uncertaintySamples = 0
    for (let cut = ranges[0][0]; cut <= ranges[0][1]; cut++) {
      cuts[0] = cut
      const alternate = model(cuts)
      if (alternate && alternate.residual <= indistinguishable)
        uncertaintySamples = Math.max(uncertaintySamples, Math.abs(cut - bestCut))
    }
    cuts[0] = bestCut
    Object.assign(diagnostic, {
      time: startTime + (start + bestCut) / sampleRate,
      beforeAmplitude: before,
      afterAmplitude: after,
      residualRms,
      uncertaintySeconds: uncertaintySamples / sampleRate
    })
    if (
      hot < 0.02 ||
      Math.min(before, after) > hot * 0.35 ||
      after > before !== candidate.rising ||
      residualRms > hot * 0.2 ||
      uncertaintySamples / sampleRate > 0.0005 ||
      bestCut <= ranges[0][0] ||
      bestCut >= ranges[0][1]
    ) {
      reject('target edge lacks a precise, isolated tone change')
      continue
    }
    diagnostics.push({ ...diagnostic, pass: true })
    events.push(diagnostic.time)
  }
  return { pass: failures.length === 0, events, diagnostics, failures }
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
    const sourceWindowEnd = (window.endTime ?? window.time + 0.01) - offset
    if (
      sourceTime < 0.2 ||
      Math.abs(sourceTime - endSeconds) <= tolerance ||
      // The tone estimate describes an interval, not an instantaneous sample
      // at its left edge. A partial transition window cannot prove an
      // envelope mismatch outside the unchanged timing allowance. Ordered
      // event alignment independently enforces that allowance at each edge.
      transitions.some((at) => sourceTime <= at + tolerance && sourceWindowEnd >= at - tolerance)
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

// Each task owns and closes its children before this boundary catches a failure.
// Abort remains fatal even in diagnostic collection mode.
export function createRuntimeCaseCollector({ collectFailures = false, onFailure = () => {} } = {}) {
  const failures = []
  return {
    failures,
    async run(name, evidence, task) {
      try {
        return await task()
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        const failure = {
          name,
          evidence,
          message: String(error?.message ?? error),
          stack: error?.stack
        }
        failures.push(failure)
        onFailure(failure, failures)
        if (!collectFailures) throw error
      }
    }
  }
}
