// Plan 189 S8: the verdicts of `pnpm smoke:soundboard`, pure so they are
// tested in node. The smoke plays a 600 ms 1 kHz fixture sound from the
// soundboard through a remote `soundPlay` intent and reads the recording's
// 1 kHz envelope (system-audio-gates.mjs). Exact placement is the fixture
// smoke's job (`smoke:soundboard-fixture`, one chunk plus 5 ms); here the
// press time maps to file time through the wall clock, so the window is wide
// enough for that mapping and still narrow enough to catch a sound placed a
// playout delay early or late.

export const SOUNDBOARD_GATES = Object.freeze({
  toneSeconds: 0.6,
  toneAmplitude: 0.5,
  // The press maps to file time through the receipt of
  // recording.status(recording), a little after the true epoch.
  pressEarlyToleranceMs: 300,
  pressLateToleranceMs: 300,
  durationToleranceMs: 60,
  // With System audio on, a monitored sound that leaked back through the
  // capture would arrive 22-52 ms later and lengthen or double the region,
  // and raise its level where the copies overlap.
  doubledLevelToleranceDb: 2
})

/** One soundboard press seen in the recording, judged against the press. */
export function evaluatePressedTone({ regions, pressFileSeconds, label = 'sound' }) {
  const failures = []
  const gates = SOUNDBOARD_GATES
  if (regions.length !== 1) {
    failures.push(
      `${label}: expected exactly one 1 kHz region, found ${regions.length} (${regions
        .map((region) => `${region.start.toFixed(3)}-${region.end.toFixed(3)}s`)
        .join(', ')})`
    )
    return { pass: false, failures }
  }
  const [region] = regions
  const offsetMs = (region.start - pressFileSeconds) * 1000
  if (offsetMs < -gates.pressEarlyToleranceMs || offsetMs > gates.pressLateToleranceMs) {
    failures.push(
      `${label}: the sound starts ${offsetMs.toFixed(0)} ms from the press, outside -${gates.pressEarlyToleranceMs}..+${gates.pressLateToleranceMs} ms`
    )
  }
  const expectedMs = gates.toneSeconds * 1000
  if (Math.abs(region.durationMs - expectedMs) > gates.durationToleranceMs) {
    failures.push(
      `${label}: the sound lasts ${region.durationMs.toFixed(0)} ms, expected ${expectedMs} ± ${gates.durationToleranceMs} ms`
    )
  }
  return { pass: failures.length === 0, failures, offsetMs, durationMs: region.durationMs, region }
}

/**
 * With System audio on and the monitor playing, the sound must be in the file
 * once: the same length and level as the run without System audio.
 */
export function evaluateNotDoubled({ withSystemAudio, reference }) {
  const failures = [...withSystemAudio.failures.map((failure) => `system audio on: ${failure}`)]
  if (withSystemAudio.region && reference?.region) {
    const delta = withSystemAudio.region.medianDbfs - reference.region.medianDbfs
    if (Math.abs(delta) > SOUNDBOARD_GATES.doubledLevelToleranceDb) {
      failures.push(
        `system audio on: the sound is ${delta.toFixed(1)} dB from the run without System audio; a second copy came back through the capture`
      )
    }
  }
  return { pass: failures.length === 0, failures }
}

/** The idle press: the backend plays it for the monitor only. */
export function evaluateIdlePress({ playback, soundId }) {
  const voice = playback?.voices?.find((entry) => entry.soundId === soundId)
  if (!voice) return { pass: false, failures: ['idle: sounds.playback never listed the sound'] }
  if (voice.onAir !== false) {
    return { pass: false, failures: ['idle: a press with no session claimed to be on air'] }
  }
  return { pass: true, failures: [] }
}
