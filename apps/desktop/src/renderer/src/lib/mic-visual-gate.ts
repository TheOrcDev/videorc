// Live feedback batch 3, B2 — the one place that decides whether the
// renderer's visual-only microphone analyser may run. The owner's complaint
// ("it's reacting while I'm not recording") was a meter that opened the mic
// whenever Studio/Sources was on screen. Now: a running session always arms
// it; an idle Studio only with the explicit "Monitor input" setting.

export type MicVisualGateInput = Readonly<{
  /** Studio or Sources tab is the active workspace tab. */
  workspaceVisible: boolean
  /** The document itself is visible (idle-CPU discipline while hidden). */
  documentVisible: boolean
  /** A backend microphone is selected. */
  microphoneSelected: boolean
  /** Capture config mute — dancing bars under a mute would lie. */
  muted: boolean
  /** Recording/streaming active OR a start/stop request in flight. */
  sessionActive: boolean
}>

/**
 * Analyser demand: the mixer is on screen, the document is visible, and a
 * microphone is selected and unmuted. Session or not.
 *
 * This used to require a running session or the "Monitor input" toggle, so an
 * idle Studio showed bars pinned at the floor — indistinguishable from a dead
 * microphone, which is exactly what people check before they hit record. The
 * meter is now live whenever it is being looked at.
 *
 * The cost is deliberate and visible: macOS shows its microphone indicator
 * while the mixer is open, because the microphone genuinely is. Leaving the
 * page or hiding the window releases it (the visibility inputs above).
 */
export function micVisualAnalyserEnabled(input: MicVisualGateInput): boolean {
  if (!input.workspaceVisible || !input.documentVisible) {
    return false
  }
  if (!input.microphoneSelected || input.muted) {
    return false
  }
  return true
}

export type AudioMixerMonitorLabel = 'Live' | 'Monitoring' | 'Idle'

/**
 * Chip copy beside the bars. "Live" = a session is running and the signal
 * path is up; "Monitoring" = idle, the user asked for input monitoring, and
 * the analyser is actually delivering; "Idle" = muted, off, or unavailable —
 * the honest state when nothing is being read.
 */
export function audioMixerMonitorLabel(input: {
  sessionActive: boolean
  signalLive: boolean
}): AudioMixerMonitorLabel {
  if (!input.signalLive) {
    return 'Idle'
  }
  return input.sessionActive ? 'Live' : 'Monitoring'
}
