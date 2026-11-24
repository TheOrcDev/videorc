import type { MicMonitorState } from '@/lib/state-labels'
import type { MediaAccessStatus } from '@/lib/backend'

// Live feedback batch 3, B2 — the one place that decides whether the
// renderer's visual-only microphone analyser may run. The owner's complaint
// ("it's reacting while I'm not recording") was a meter that opened the mic
// whenever Studio/Sources was on screen.
//
// Plan 260 S1.3a (owner 2026-11-09): the analyser is the last renderer
// microphone, kept ONLY for the idle meter of a microphone the backend cannot
// meter between sessions yet: the Windows inputs (D1; a backend meter-only
// capture there deletes this). A CoreAudio or PipeWire input is metered by the
// backend's standing-by microphone (Linux's since S1.3), and no session or
// Clips bus ever meters through Chromium (D3; issue 1064).

export type MicVisualGateInput = Readonly<{
  /** Studio or Sources tab is the active workspace tab. */
  workspaceVisible: boolean
  /** The document itself is visible (idle-CPU discipline while hidden). */
  documentVisible: boolean
  /** A backend microphone is selected. */
  microphoneSelected: boolean
  /**
   * The selected microphone is a CoreAudio or PipeWire input: the backend's
   * standing-by microphone meters it, so the renderer never opens it.
   */
  backendMetered: boolean
  /** Capture config mute — dancing bars under a mute would lie. */
  muted: boolean
  /**
   * Recording/streaming active, a start/stop request in flight, or a Clips
   * bus running: the backend's bus meters what is recorded.
   */
  sessionActive: boolean
}>

/**
 * Analyser demand: the mixer is on screen, the document is visible, and a
 * microphone the backend cannot meter idle is selected and unmuted, with no
 * session or bus running.
 *
 * An idle meter used to need a running session or the "Monitor input"
 * toggle, so an idle Studio showed bars pinned at the floor — indistinguishable
 * from a dead microphone, which is exactly what people check before they hit
 * record. The meter is live whenever it is being looked at; on Windows and
 * this analyser is what makes it so on Windows.
 *
 * The cost is deliberate and visible: the OS shows its microphone indicator
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
  if (input.backendMetered || input.sessionActive) {
    return false
  }
  return true
}

/**
 * The meter's state beside the bars, for its data attribute and the probes.
 * `live` = a session is running and the signal path is up; `monitoring` =
 * idle and a level is actually arriving (the backend's standing-by
 * microphone, or the analyser on Windows); `muted` = the microphone is
 * muted, so flat bars are the mute and not a dead microphone; `silent` = the
 * running bus reads digital silence from an unmuted microphone (issue 1064:
 * the recording gets nothing, whatever the room sounds like); `idle` = off
 * or unavailable, the honest state when nothing is being read. The words a
 * streamer hears come from `micSignalLabel` (plan 174 C-38: "Receiving",
 * never "Live" or "Monitoring").
 */
export function audioMixerMonitorState(input: {
  sessionActive: boolean
  signalLive: boolean
  muted?: boolean
  /** The backend's silence watchdog reports the captured microphone silent. */
  silent?: boolean
}): MicMonitorState {
  if (input.muted) {
    return 'muted'
  }
  if (input.silent) {
    return 'silent'
  }
  if (!input.signalLive) {
    return 'idle'
  }
  return input.sessionActive ? 'live' : 'monitoring'
}

/**
 * No OS gate stands between the renderer and the microphone: macOS/Windows
 * granted it, or Linux has no OS grant at all (`not-applicable`, Linux plan
 * 0011: the level never showed on Linux). Anything else stays closed so a
 * meter never becomes an implicit permission prompt.
 */
export function microphoneAccessOpen(permissionStatus: MediaAccessStatus | undefined): boolean {
  return permissionStatus === 'granted' || permissionStatus === 'not-applicable'
}
