// Instant record (P5) — the one place that decides whether the backend keeps
// the selected microphone open while Studio is visible. Same visibility
// discipline as the visual analyser (mic-visual-gate.ts): the device is only
// open while someone is looking at Studio, so the macOS microphone indicator
// stays honest.

export type WarmMicrophoneGateInput = Readonly<{
  /** Settings toggle (default on). */
  keepWarm: boolean
  /** Studio or Sources tab is the active workspace tab. */
  workspaceVisible: boolean
  /** The window is actually on screen (main-fed, never DOM visibility alone). */
  documentVisible: boolean
  /** Selected microphone id; only native CoreAudio inputs can be kept warm. */
  microphoneId: string | undefined
  /** Capture config mute — a muted mixer releases the device like the analyser does. */
  muted: boolean
}>

export function isCoreAudioMicrophoneId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('microphone:coreaudio:')
}

export function warmMicrophoneWanted(input: WarmMicrophoneGateInput): boolean {
  if (!input.keepWarm) return false
  if (!input.workspaceVisible || !input.documentVisible) return false
  if (!isCoreAudioMicrophoneId(input.microphoneId) || input.muted) return false
  return true
}
