// Pure math for the live microphone meter: dBFS mapping, broadcast-style
// ballistics (fast attack, slower decay, peak hold), and backend-device →
// WebAudio device matching by label. No WebAudio, no DOM — unit-testable.
// The WebAudio side lives in hooks/use-mic-level-meter.ts.

export const MIC_METER_FLOOR_DB = -60

export function samplesRmsAndPeak(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) {
    return { rms: 0, peak: 0 }
  }
  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    if (magnitude > peak) {
      peak = magnitude
    }
    sumSquares += sample * sample
  }
  return { rms: Math.sqrt(sumSquares / samples.length), peak }
}

export function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 0) {
    return MIC_METER_FLOOR_DB
  }
  return Math.max(MIC_METER_FLOOR_DB, 20 * Math.log10(amplitude))
}

/** Linear-in-dB meter position over the floor..0 dBFS window, clamped to 0..1. */
export function dbToMeterLevel(db: number, floorDb: number = MIC_METER_FLOOR_DB): number {
  return Math.min(1, Math.max(0, (db - floorDb) / -floorDb))
}

export type MeterBallisticsState = {
  /** Smoothed bar position (0..1). */
  level: number
  /** Peak-hold marker position (0..1). */
  peakLevel: number
  /** Timestamp (ms) until which the held peak may not decay. */
  peakHeldUntilMs: number
}

export const INITIAL_METER_BALLISTICS: MeterBallisticsState = {
  level: 0,
  peakLevel: 0,
  peakHeldUntilMs: 0
}

export type MeterBallisticsOptions = {
  attackMs: number
  decayMs: number
  peakHoldMs: number
  peakDecayMs: number
}

export const DEFAULT_METER_BALLISTICS: MeterBallisticsOptions = {
  // Fast rise so a spoken syllable registers on the next frame; slower fall so
  // the bar reads as motion instead of flicker (broadcast PPM-ish feel).
  attackMs: 15,
  decayMs: 350,
  peakHoldMs: 1200,
  peakDecayMs: 600
}

function approach(current: number, target: number, elapsedMs: number, tauMs: number): number {
  if (tauMs <= 0) {
    return target
  }
  return current + (target - current) * (1 - Math.exp(-elapsedMs / tauMs))
}

export function advanceMeterBallistics(
  state: MeterBallisticsState,
  targetLevel: number,
  elapsedMs: number,
  nowMs: number,
  options: MeterBallisticsOptions = DEFAULT_METER_BALLISTICS
): MeterBallisticsState {
  const target = Math.min(1, Math.max(0, targetLevel))
  const rising = target > state.level
  const level = approach(
    state.level,
    target,
    elapsedMs,
    rising ? options.attackMs : options.decayMs
  )

  let peakLevel = state.peakLevel
  let peakHeldUntilMs = state.peakHeldUntilMs
  if (target >= peakLevel) {
    peakLevel = target
    peakHeldUntilMs = nowMs + options.peakHoldMs
  } else if (nowMs >= peakHeldUntilMs) {
    peakLevel = Math.max(level, approach(peakLevel, level, elapsedMs, options.peakDecayMs))
  }
  return { level, peakLevel, peakHeldUntilMs }
}

function normalizeDeviceName(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * Match the backend's selected microphone (CoreAudio/dshow name) to a WebAudio
 * input by label: exact normalized match first, then containment either way.
 * Returns undefined when nothing matches — callers fall back to the default
 * input rather than metering a device the user did not select.
 */
export function matchMicrophoneDeviceId(
  backendName: string | undefined,
  inputs: { deviceId: string; label: string }[]
): string | undefined {
  if (!backendName) {
    return undefined
  }
  const wanted = normalizeDeviceName(backendName)
  if (!wanted) {
    return undefined
  }
  const exact = inputs.find((input) => normalizeDeviceName(input.label) === wanted)
  if (exact) {
    return exact.deviceId
  }
  return inputs.find((input) => {
    const label = normalizeDeviceName(input.label)
    return label.length > 0 && (label.includes(wanted) || wanted.includes(label))
  })?.deviceId
}

export const MIC_CLIP_THRESHOLD_DB = -1
export const MIC_CLIP_HOLD_MS = 1500

/**
 * Clip-hold deadline: a peak at/above the clip threshold arms (or extends)
 * the indicator for MIC_CLIP_HOLD_MS; quieter peaks leave the running
 * deadline untouched so a brief hot transient stays visible.
 */
export function advanceClipHoldDeadline(
  deadline: number,
  peakDb: number | null,
  now: number
): number {
  if (peakDb !== null && peakDb >= MIC_CLIP_THRESHOLD_DB) {
    return now + MIC_CLIP_HOLD_MS
  }
  return deadline
}

/**
 * Deterministic band heights for the coarse fallback meter paths (backend
 * 1 Hz level, on-demand sample): a center-weighted hump scaled by the real
 * level — never fake noise. The center band equals the level exactly.
 */
export function fallbackBandLevels(level: number, bands: number): number[] {
  if (bands <= 0) {
    return []
  }
  const clamped = Math.min(1, Math.max(0, level))
  const center = (bands - 1) / 2
  return Array.from({ length: bands }, (_, index) => {
    const distance = center === 0 ? 0 : Math.abs(index - center) / center
    return clamped * (1 - 0.6 * distance)
  })
}
