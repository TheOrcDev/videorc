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

/**
 * Plan 220 S1.3b: the backend's monitor (`sound_monitor.rs`) logs each voice
 * that leaves its mix. A report that the voice rendered nearly all its frames
 * is the proof the monitor played it to the output device: CoreAudio pulls the
 * frames only while the unit plays.
 */
export const MONITOR_GATES = Object.freeze({
  // Of the sound's frames, the share the monitor must have rendered.
  playedShare: 0.9,
  // How long after the tone the report may arrive (the output thread logs
  // every 250 ms).
  reportWaitMs: 3000,
  // The control tone (another app, 440 Hz) proves the capture hears the
  // computer: its band reaches at least this.
  controlPresentDbfs: -40,
  // A monitor-only sound in the Clips ring. A copy that came back through
  // the capture would read the sound's own level minus System audio's 6 dB
  // (about -21 dBFS): no tone region anywhere in the clip, and around the
  // press the 1 kHz band's loudest 300 ms running median stays quiet. Quiet
  // is not digital silence on purpose: a shared host plays other audio into
  // the capture, which leaks into a 20 ms band window. So the press window
  // may read up to `bandQuietDbfs`, or up to `aboveElsewhereDb` over the rest
  // of the clip when the host is louder, and never over `bandCeilingDbfs`
  // (the tone detector's own threshold, 9 dB under a returning copy).
  bandQuietDbfs: -40,
  aboveElsewhereDb: 6,
  bandCeilingDbfs: -30,
  runningMedianSeconds: 0.3,
  // The press maps to clip time through the wall clock and the clip's end.
  pressEarlySeconds: 0.5,
  pressLateSeconds: 0.5
})

/** `Sound monitor played voice v-3 for 28800 of 28800 frames from frame 0.` */
export function parseMonitorVoiceLine(line) {
  // The backend's log lines may carry ANSI colour codes.
  // oxlint-disable-next-line no-control-regex
  const plain = String(line ?? '').replace(/\u001b\[[0-9;]*m/g, '')
  const match =
    /Sound monitor played voice (v-\d+) for (\d+) of (\d+) frames from frame (\d+)(, then faded out)?/.exec(
      plain
    )
  if (!match) return null
  return {
    voiceId: match[1],
    rendered: Number(match[2]),
    frames: Number(match[3]),
    offset: Number(match[4]),
    stopped: Boolean(match[5])
  }
}

/** The backend's monitor played this voice through, from the top. */
export function evaluateMonitorPlayed({ reports, voiceId, label = 'monitor' }) {
  const report = reports.find((entry) => entry.voiceId === voiceId)
  if (!report) {
    return {
      pass: false,
      failures: [`${label}: the backend's monitor never reported ${voiceId ?? 'the voice'}`]
    }
  }
  const failures = []
  if (report.offset !== 0) {
    failures.push(`${label}: the monitor started ${voiceId} at frame ${report.offset}, not the top`)
  }
  if (report.stopped || report.rendered < report.frames * MONITOR_GATES.playedShare) {
    failures.push(
      `${label}: the monitor played ${report.rendered} of ${report.frames} frames of ${voiceId}${report.stopped ? ' and faded it out' : ''}`
    )
  }
  return { pass: failures.length === 0, failures, report }
}

const maxDbfs = (envelope) =>
  envelope.reduce((max, point) => (point.dbfs > max ? point.dbfs : max), -Infinity)

/**
 * The control tone from another app reached the capture: System audio was
 * really on and hearing the computer, so a missing copy of the monitor proves
 * something. `envelope` is the file's 440 Hz envelope (`toneEnvelope`).
 */
export function evaluateControlHeard({ envelope, label = 'control' }) {
  const controlDbfs = maxDbfs(envelope)
  if (!(controlDbfs >= MONITOR_GATES.controlPresentDbfs)) {
    return {
      pass: false,
      failures: [
        `${label}: the 440 Hz control tone never reached System audio (${Number.isFinite(controlDbfs) ? controlDbfs.toFixed(1) : 'nothing'} dBFS), so the capture proves nothing`
      ],
      controlDbfs
    }
  }
  return { pass: true, failures: [], controlDbfs }
}

/**
 * Plan 220 S1.3b, never doubled: the Clips ring with System audio on and no
 * recording. A press there is the monitor's only (the ring never mixes it),
 * so any 1 kHz in the saved clip came back through the capture. The clip must
 * reach back past the press, and hear the control tone.
 */
export function evaluateMonitorOnlyClip({
  toneEnvelope,
  regions,
  controlEnvelope,
  clipSeconds,
  coveredSeconds,
  pressAgoSeconds,
  toneSeconds
}) {
  const gates = MONITOR_GATES
  const failures = []
  if (!(coveredSeconds >= pressAgoSeconds)) {
    failures.push(
      `monitor-only: the clip holds ${coveredSeconds} s but the press was ${pressAgoSeconds.toFixed(2)} s before the save`
    )
  }
  if (regions.length > 0) {
    failures.push(
      `monitor-only: the clip carries a 1 kHz tone (${regions
        .map(
          (region) =>
            `${region.start.toFixed(2)}-${region.end.toFixed(2)} s at ${region.medianDbfs.toFixed(1)} dBFS`
        )
        .join(', ')}); the monitor's sound came back through System audio`
    )
  }
  const pressClipSeconds = clipSeconds - pressAgoSeconds
  const from = pressClipSeconds - gates.pressEarlySeconds
  const to = pressClipSeconds + toneSeconds + gates.pressLateSeconds
  const windowPoints = toneEnvelope.filter((point) => point.t >= from && point.t <= to)
  if (
    windowPoints.length < 2 ||
    windowPoints[0].t > from + 0.05 ||
    windowPoints.at(-1).t < to - 0.05
  ) {
    failures.push(
      `monitor-only: the press window ${from.toFixed(2)}-${to.toFixed(2)} s is not inside the clip`
    )
  }
  const pressBandDbfs = runningMedianMax(toneEnvelope, from, to, gates.runningMedianSeconds)
  const elsewhereBandDbfs = runningMedianMax(
    toneEnvelope.filter((point) => point.t < from || point.t > to),
    -Infinity,
    Infinity,
    gates.runningMedianSeconds
  )
  const allowedDbfs = Math.min(
    gates.bandCeilingDbfs,
    Math.max(gates.bandQuietDbfs, elsewhereBandDbfs + gates.aboveElsewhereDb)
  )
  if (pressBandDbfs > allowedDbfs) {
    failures.push(
      `monitor-only: around the press the clip's 1 kHz band reads ${pressBandDbfs.toFixed(1)} dBFS (over ${gates.runningMedianSeconds * 1000} ms, ${elsewhereBandDbfs.toFixed(1)} dBFS elsewhere, ${allowedDbfs.toFixed(1)} allowed); the monitor's sound came back through System audio`
    )
  }
  const control = evaluateControlHeard({ envelope: controlEnvelope, label: 'monitor-only' })
  failures.push(...control.failures)
  return {
    pass: failures.length === 0,
    failures,
    evidence: {
      pressClipSeconds,
      pressBandDbfs,
      elsewhereBandDbfs,
      allowedDbfs,
      toneMaxDbfs: maxDbfs(toneEnvelope),
      controlDbfs: control.controlDbfs,
      coveredSeconds,
      pressAgoSeconds
    }
  }
}

/** The loudest running median (over `spanSeconds`) of an envelope in [from, to]. */
export function runningMedianMax(envelope, from, to, spanSeconds) {
  const points = envelope.filter((point) => point.t >= from && point.t <= to)
  let best = -Infinity
  for (let index = 0; index < points.length; index += 1) {
    const span = points.filter(
      (point) => point.t >= points[index].t && point.t < points[index].t + spanSeconds
    )
    if (points.at(-1).t - points[index].t < spanSeconds * 0.9) break
    const sorted = span.map((point) => point.dbfs).sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median > best) best = median
  }
  return best
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
