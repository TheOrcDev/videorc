// Instant record (P5) — the one place that decides whether the backend keeps
// the selected microphone open while Studio is visible. Same visibility
// discipline as the visual analyser (mic-visual-gate.ts): the device is only
// open while someone is looking at Studio, so the macOS microphone indicator
// stays honest.
//
// Plan 260 S1.3a: the standing-by microphone is also every idle meter's feed
// for a CoreAudio input (the renderer opens no microphone for it). So Keep
// microphone ready no longer decides whether it opens, only what Record does
// with it (D2, owner 2026-11-09): on, Record takes it warm; off, it stands by
// for the meter only and Record opens the device fresh, as before. The
// microphone indicator is lit either way while Studio is on screen, as it was
// when the renderer's own meter held the device.

export type WarmMicrophoneGateInput = Readonly<{
  /** Studio or Sources tab is the active workspace tab. */
  workspaceVisible: boolean
  /** The window is actually on screen (main-fed, never DOM visibility alone). */
  documentVisible: boolean
  /** Selected microphone id; CoreAudio inputs stand by, and PipeWire and DirectShow ones for the meter only. */
  microphoneId: string | undefined
  /** Capture config mute — a muted mixer releases the device like the analyser does. */
  muted: boolean
}>

export function isCoreAudioMicrophoneId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('microphone:coreaudio:')
}

/**
 * Plan 260 S1.3: a microphone the backend stands by and meters between
 * sessions: a CoreAudio input (macOS), or a capture-worker input, for the
 * meter only: a PipeWire source (Linux) or a DirectShow microphone (Windows).
 */
export function isBackendMeteredMicrophoneId(id: string | undefined): boolean {
  return (
    isCoreAudioMicrophoneId(id) ||
    (typeof id === 'string' &&
      (id.startsWith('microphone:linux-pulse:') || id.startsWith('microphone:windows-dshow:')))
  )
}

export function warmMicrophoneWanted(input: WarmMicrophoneGateInput): boolean {
  if (!input.workspaceVisible || !input.documentVisible) return false
  if (!isBackendMeteredMicrophoneId(input.microphoneId) || input.muted) return false
  return true
}

/**
 * D2: with Keep microphone ready off (the setting is on by default) the
 * standing-by microphone serves the meter only, and Record never takes it.
 */
export function warmMicrophoneMeterOnly(keepMicrophoneWarm: boolean | undefined): boolean {
  return keepMicrophoneWarm === false
}

/**
 * Refusals that say nothing lasting about the device: a session or its
 * cleanup still holds the microphone, another open is in flight, or a disarm
 * overtook this open. With no renderer meter behind it any more, the idle
 * meter asks again instead of resting until the next change.
 */
const TRANSIENT_WARM_REFUSALS = new Set([
  'session-active',
  'cleanup-pending',
  'opening',
  'superseded'
])

export const WARM_MICROPHONE_RETRY_MS = 3_000
/** A device that failed to open is tried again, but rarely: each try logs. */
export const WARM_MICROPHONE_OPEN_FAILED_RETRY_MS = 15_000

/** How long to wait before arming again after this refusal; null never retries. */
export function warmMicrophoneRetryDelayMs(reason: string | undefined): number | null {
  if (reason === 'open-failed') return WARM_MICROPHONE_OPEN_FAILED_RETRY_MS
  if (reason !== undefined && TRANSIENT_WARM_REFUSALS.has(reason)) return WARM_MICROPHONE_RETRY_MS
  return null
}
