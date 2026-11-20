import type {
  LayoutSettings,
  Scene,
  SourceSelection,
  SrtInputConnection,
  SrtInputState,
  StreamingSettings
} from './backend'
import { buildSimulcastParams, type CaptureConfig } from './capture'
import type { SourceStatus } from './source-status'
import { SOURCE_RECEIVING_LABEL } from './state-labels'

// Plan 255: the SRT input setting and its camera, as the Studio shows them.
// Pure, so the Settings opt-in, the Sources camera row and the Go Live ask
// (the dialog's and an agent's `go_live`) share one answer.

export const SRT_CAMERA_ID = 'camera:srt-input'

export const SRT_INPUT_TITLE = 'SRT input'
/** Option B: the opt-in in Settings; the camera's own settings live in Sources. */
export const SRT_INPUT_DESCRIPTION = 'Adds the SRT Camera to the camera list in Sources.'
/** D5: lip sync stays with the microphone sync offset. */
export const SRT_INPUT_LIP_SYNC_NOTE =
  'This camera arrives late. Set the microphone sync offset in the audio mixer to match.'
export const SRT_PORT_REFUSED = 'Choose a port from 1024 to 65535.'

/** D11: a Connection, never a number; each label shows its latency. */
export const SRT_CONNECTION_OPTIONS: ReadonlyArray<{ value: SrtInputConnection; label: string }> = [
  { value: 'cableOrThisComputer', label: 'Cable or this computer · 0 ms' },
  { value: 'wifi', label: 'Wi-Fi · 120 ms' },
  { value: 'internet', label: 'Internet · 500 ms' }
]

/** D9: the setting exists only where the backend supports it (macOS). */
export function srtInputHidden(state: SrtInputState | null): boolean {
  return !state?.supported
}

export function isSrtCameraId(cameraId: string | null | undefined): boolean {
  return cameraId === SRT_CAMERA_ID
}

export type SrtPortParse = { kind: 'port'; port: number } | { kind: 'refused'; message: string }

export function parseSrtPort(text: string): SrtPortParse {
  const trimmed = text.trim()
  const port = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return Number.isInteger(port) && port >= 1024 && port <= 65535
    ? { kind: 'port', port }
    : { kind: 'refused', message: SRT_PORT_REFUSED }
}

/** D17: the camera's detail line, under Sources → Camera. */
export function srtCameraFacts(state: SrtInputState | null): string | null {
  return state ? state.status.detail : null
}

/**
 * What goes live: the picked sources, each leg's composition and the
 * destinations, as `session.start` sends them (a `StartSessionParams` is
 * one). No streaming settings means a recording.
 */
export interface GoLiveComposition {
  sources: Pick<SourceSelection, 'cameraId'>
  layout: LayoutSettings
  scene?: Scene
  simulcast?: { layout: LayoutSettings; scene?: Scene }
  streaming?: Pick<StreamingSettings, 'enabled' | 'targets'>
}

/**
 * The backend composites the picked camera in a leg (scene.rs) unless the
 * leg's scene has no visible camera, its camera is hidden, or its preset is
 * screen-only. Freeform keeps the camera whatever the preset.
 */
function legShowsCamera(layout: LayoutSettings, scene: Scene | undefined): boolean {
  if (scene) return scene.sources.some((source) => source.kind === 'camera' && source.visible)
  if (layout.sourceVisibility?.camera === false) return false
  if (layout.arrangementMode === 'freeform') return true
  return layout.layoutPreset !== 'screen-only' && layout.layoutPreset !== 'vertical-screen-only'
}

/**
 * The compositions that stream, routed as the backend sends destinations
 * (`resolveProviderStreamOutputPlan`): with a vertical leg, vertical
 * destinations take it and every other one takes the main composition;
 * without one, every destination takes the main composition. A recording
 * streams none.
 */
function streamedLegs(
  going: GoLiveComposition
): { name: 'main' | 'vertical'; layout: LayoutSettings; scene?: Scene }[] {
  if (going.streaming?.enabled !== true) return []
  const on = going.streaming.targets.filter((target) => target.enabled)
  const vertical = (target: (typeof on)[number]): boolean =>
    going.simulcast !== undefined && target.outputOrientation === 'vertical'
  return [
    ...(on.some((target) => !vertical(target)) ? [{ name: 'main' as const, ...going }] : []),
    ...(going.simulcast && on.some(vertical)
      ? [{ name: 'vertical' as const, ...going.simulcast }]
      : [])
  ]
}

/**
 * The SRT Camera's badge in Sources (live QA, 2026-11-15). Its pacer keeps
 * the camera's pipeline busy with the held frame or the still, so the
 * pipeline reads "Receiving" whatever the sender does: while it does, the
 * SRT signal decides, as the detail line does. Any other pipeline status
 * (starting, failed, switching) stands.
 */
export function srtCameraSourceStatus(
  state: SrtInputState | null,
  pipeline: SourceStatus | null
): SourceStatus | null {
  if (!state || pipeline?.label !== SOURCE_RECEIVING_LABEL) return pipeline
  switch (state.status.signal) {
    case 'receiving':
      return pipeline
    case 'holding':
      return { label: 'No frames', tone: 'warn' }
    case 'waiting':
      return { label: 'No signal', tone: 'neutral' }
    case 'unsupportedCodec':
      return { label: 'No picture', tone: 'warn' }
  }
}

/**
 * D15: a scene that streams uses the SRT Camera and it shows a still. A
 * short gap the hold covers still counts as a signal. A picked SRT Camera
 * that no streamed leg shows (a screen-only scene, a leg no destination
 * takes, a recording) is no reason to ask.
 */
export function srtCameraHasNoSignal(
  state: SrtInputState | null,
  going: GoLiveComposition
): boolean {
  return srtAskFacts(state, going) !== null
}

/**
 * What the SRT Camera's ask covers, or null when there is nothing to ask:
 * the signal, the streamed legs that show the camera and the port senders
 * dial. An answer holds only while these stay the same.
 * Frame counters, the rate and the detail line are not facts the streamer
 * answered, and neither is a refusal: it clears on its own and leaves the
 * no-signal risk as it was (the ask shows it as context).
 */
export function srtAskFacts(state: SrtInputState | null, going: GoLiveComposition): string | null {
  if (!state?.enabled || !isSrtCameraId(going.sources.cameraId)) return null
  const signal = state.status.signal
  if (signal !== 'waiting' && signal !== 'unsupportedCodec') return null
  const legs = streamedLegs(going)
    .filter((leg) => legShowsCamera(leg.layout, leg.scene))
    .map((leg) => leg.name)
  if (legs.length === 0) return null
  return JSON.stringify({ signal, legs, port: state.port })
}

/**
 * D15 before the start, from this attempt's capture setup (its streaming
 * without the destinations it leaves out): the Go Live dialog's ask and an
 * agent's `go_live` read it the same way. A Go Live always streams, whatever
 * Output's saved mode. The start itself checks the exact `session.start`
 * composition again.
 */
export function goLiveSrtNoSignal(state: SrtInputState | null, config: CaptureConfig): boolean {
  return goLiveSrtAskFacts(state, config) !== null
}

/** `srtAskFacts` for this attempt's capture setup, as `goLiveSrtNoSignal` reads it. */
export function goLiveSrtAskFacts(
  state: SrtInputState | null,
  config: CaptureConfig
): string | null {
  const live = { ...config, streamEnabled: true }
  return srtAskFacts(state, {
    sources: live.sources,
    layout: live.layout,
    simulcast: buildSimulcastParams(live),
    streaming: live.streaming
  })
}

/** D15: the Go Live ask's words. */
export const SRT_NO_SIGNAL_CONFIRM = {
  title: 'Go live anyway?',
  description: 'The SRT Camera has no signal.',
  confirmLabel: 'Go live anyway',
  cancelLabel: 'Go back'
} as const

/** D15 for an agent's `go_live`, which has no dialog to ask in. */
export const ALLOW_NO_SIGNAL_HINT = 'Pass allowNoSignal: true to go live anyway.'

/** The dialog's sentence and how an agent goes ahead anyway. */
export function headlessSrtNoSignalRefusal(): string {
  return `${SRT_NO_SIGNAL_CONFIRM.description} ${ALLOW_NO_SIGNAL_HINT}`
}
