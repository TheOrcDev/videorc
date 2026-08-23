// Live feedback batch 3, B2 — the one place that decides whether the
// renderer's visual-only microphone analyser may run. The owner's complaint
// ("it's reacting while I'm not recording") was a meter that opened the mic
// whenever Studio/Sources was on screen. Now: a running session always arms
// it; an idle Studio only with the explicit "Monitor input" setting.

import type { SettingsState } from './capture'

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
  /** Persisted settings.audioMixer.monitorWhenIdle. */
  monitorWhenIdle: boolean
}>

/** Persisted preference with its default (OFF) applied. */
export function audioMixerMonitorWhenIdle(
  settings: Pick<SettingsState, 'audioMixer'> | undefined
): boolean {
  return settings?.audioMixer?.monitorWhenIdle === true
}

/** Settings updater for the Monitor input toggle (keeps sibling mixer prefs). */
export function withAudioMixerMonitorWhenIdle<T extends Pick<SettingsState, 'audioMixer'>>(
  settings: T,
  monitorWhenIdle: boolean
): T {
  return { ...settings, audioMixer: { ...settings.audioMixer, monitorWhenIdle } }
}

/**
 * Analyser demand: (session active OR monitor-when-idle) AND the visual is
 * actually on screen for an unmuted, selected microphone. Starting a session
 * arms the meter without touching the toggle; stopping it disarms unless the
 * user opted into idle monitoring.
 */
export function micVisualAnalyserEnabled(input: MicVisualGateInput): boolean {
  if (!input.workspaceVisible || !input.documentVisible) {
    return false
  }
  if (!input.microphoneSelected || input.muted) {
    return false
  }
  return input.sessionActive || input.monitorWhenIdle
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
