import { cameraLowFrameRateLine, type CameraLowFrameRate } from '@/lib/camera-frame-rate'

// Issue #1275: a slow scene switch said only "Switching…", in place of the
// name the streamer clicked, for the seconds it waited on a camera's first
// frame or the preview. The control keeps the name with a spinner, and after
// a moment one status line names what the switch is waiting for, and a slow
// camera when that is the reason. A click that takes over a switch says so
// at once.

/** What a scene switch is waiting for, in the order it waits. */
export type SceneSwitchPhase =
  /** The source check and the scene's current state, before Videorc is asked. */
  | 'preparing'
  /** Videorc applies it, starting any source it adds and waiting for its first frame. */
  | 'starting'
  /** The new scene is drawn into the recording, livestream or preview. */
  | 'drawing'
  /** The Preview window shows it. */
  | 'presenting'

export interface SceneSwitchProgress {
  /** The layout intent this progress belongs to; a newer one replaces it. */
  intentId: number
  /** The name the streamer clicked: a layout's label, "Freeform" or a saved scene's name. */
  target: string
  phase: SceneSwitchPhase
  startedAtMs: number
  /** The switch this one took over, by name, or null. */
  replaced: string | null
  /** Whether the scene being applied shows the camera (or the screen). */
  showsCamera: boolean
  showsScreen: boolean
}

/** How long a switch runs before its status line appears. */
export const SCENE_SWITCH_STATUS_DELAY_MS = 1500

/** The label a control shows beside its name while its switch runs. */
export const SCENE_SWITCH_PENDING_LABEL = 'Applying…'

/** A new switch, taking over `previous` when one is still running toward another target. */
export function startSceneSwitchProgress(
  previous: SceneSwitchProgress | null,
  next: { intentId: number; target: string; nowMs: number }
): SceneSwitchProgress {
  return {
    intentId: next.intentId,
    target: next.target,
    phase: 'preparing',
    startedAtMs: next.nowMs,
    replaced: previous && previous.target !== next.target ? previous.target : null,
    showsCamera: false,
    showsScreen: false
  }
}

/** `progress` moved on to a later phase, only while it is still the switch `intentId` started. */
export function advanceSceneSwitchProgress(
  progress: SceneSwitchProgress | null,
  intentId: number,
  patch: Partial<Pick<SceneSwitchProgress, 'phase' | 'showsCamera' | 'showsScreen'>>
): SceneSwitchProgress | null {
  if (!progress || progress.intentId !== intentId) return progress
  const next = { ...progress, ...patch }
  return next.phase === progress.phase &&
    next.showsCamera === progress.showsCamera &&
    next.showsScreen === progress.showsScreen
    ? progress
    : next
}

/** The status line shows once the switch has run a moment, or at once when it took over another. */
export function sceneSwitchStatusVisible(progress: SceneSwitchProgress, nowMs: number): boolean {
  return progress.replaced !== null || nowMs - progress.startedAtMs >= SCENE_SWITCH_STATUS_DELAY_MS
}

function phaseLabel(progress: SceneSwitchProgress): string {
  switch (progress.phase) {
    case 'preparing':
      return 'Getting ready…'
    case 'starting':
      if (progress.showsCamera) return "Waiting for the camera's first frame…"
      if (progress.showsScreen) return "Waiting for the screen's first frame…"
      return SCENE_SWITCH_PENDING_LABEL
    case 'drawing':
      return 'Drawing the new scene…'
    case 'presenting':
      return 'Updating the preview…'
  }
}

/**
 * The status line: "Side by side · Waiting for the camera's first frame…",
 * then what the streamer should know about it: the switch it replaced, and a
 * slow camera when the scene shows it.
 */
export function sceneSwitchStatusLine(
  progress: SceneSwitchProgress,
  camera?: { name?: string; lowFrameRate: CameraLowFrameRate | null }
): { title: string; detail: string | null } {
  const details: string[] = []
  if (progress.replaced) details.push(`Replaces the switch to ${progress.replaced}.`)
  if (progress.showsCamera && progress.phase !== 'preparing' && camera?.lowFrameRate) {
    details.push(cameraLowFrameRateLine(camera.name, camera.lowFrameRate))
  }
  return {
    title: `${progress.target} · ${phaseLabel(progress)}`,
    detail: details.length > 0 ? details.join(' ') : null
  }
}
