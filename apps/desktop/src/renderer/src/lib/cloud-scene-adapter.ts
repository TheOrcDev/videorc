import type {
  CloudStage,
  EffectiveSceneBackground,
  LayoutSettings,
  Scene,
  SceneConfigParams,
  SourceSelection,
  VideoSettings
} from '@/lib/backend'
import { layoutPresetOrientation } from '@/lib/capture'
import { cloudSceneFromNative } from '@/lib/cloud-scene-native'
import type { RoomSceneCommit, SceneContent } from '@/lib/room-scene-publisher'
import { SCENE_MOTION_MS, type SceneOrientation } from '../../../shared/cloud-scene'

/**
 * Plan 249 S12: the active-output scene adapter. While a room holds the
 * camera, a scene command (click, hotkey, remote, agent, Follow) changes the
 * room program instead of the native session: the native engine resolves
 * the scene without committing it (no capture start, no camera-lend wait),
 * the result is translated, the sources it shows must be in the room, and
 * only then is it committed to every lane at once. The answer names what the
 * outputs confirmed; nothing is reported applied that was not drawn.
 */

/** The room program's canvas for each orientation (web `STAGE_CANVAS`). */
export const ROOM_SCENE_CANVAS: Record<SceneOrientation, { width: number; height: number }> = {
  h: { width: 1920, height: 1080 },
  v: { width: 1080, height: 1920 }
}

export type RoomSceneTarget = {
  layout: LayoutSettings
  sources: SourceSelection
  background: EffectiveSceneBackground | null
  video: VideoSettings
  /** `SavedScene.cloud`; absent for a preset. */
  extension?: unknown
}

export type RoomSceneRoom = {
  identity: string | null
  /** The host's room camera is publishing. */
  cameraPublished: boolean
  /** The host turned the room camera off on purpose. */
  cameraOff: boolean
  /** The host's room screen is publishing. */
  screenPublished: boolean
  stage: CloudStage
  commitScene(content: SceneContent | null): Promise<RoomSceneCommit>
}

export type RoomSceneDeps = {
  /** `cloud.scene.resolve`: Rust `scene_from_capture_config`, uncommitted. */
  resolve(params: SceneConfigParams): Promise<Scene>
  /** The room as it is now (read again after every wait). */
  room(): RoomSceneRoom | null
  setStage(stage: CloudStage): Promise<void>
  /** Settings' Animate scene changes. */
  animate: boolean
  /** How long the sources may take to arrive in the room. */
  readyWaitMs?: number
  /**
   * Still wanted, checked in the same tick as the commit: an edit re-send
   * that a clear, a chosen scene or another room overtook commits nothing.
   */
  current?: () => boolean
  sleep?: (ms: number) => Promise<void>
}

export type RoomSceneResult = {
  ok: boolean
  message?: string
  commit?: RoomSceneCommit
  orientation?: SceneOrientation
}

export function roomSceneMessage(commit: RoomSceneCommit): string | undefined {
  switch (commit.state) {
    case 'applied':
      return undefined
    case 'preview':
      return 'Scene set. It shows once the stream or recording starts.'
    case 'waiting':
      return commit.reason ?? "The program hasn't drawn the scene yet."
    case 'superseded':
      return undefined
    default:
      return commit.reason ?? "The scene couldn't be sent to the room."
  }
}

export async function applySceneToRoom(
  target: RoomSceneTarget,
  deps: RoomSceneDeps
): Promise<RoomSceneResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const orientation: SceneOrientation =
    layoutPresetOrientation(target.layout.layoutPreset) === 'vertical' ? 'v' : 'h'
  const canvas = ROOM_SCENE_CANVAS[orientation]
  let resolved: Scene
  try {
    resolved = await deps.resolve({
      sources: target.sources,
      layout: target.layout,
      video: { ...target.video, width: canvas.width, height: canvas.height },
      ...(target.background ? { background: target.background } : {})
    })
  } catch (error) {
    return {
      ok: false,
      message: `The scene couldn't be worked out: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  const translation = cloudSceneFromNative({
    scene: resolved,
    layout: target.layout,
    background: target.background,
    orientation,
    extension: target.extension
  })
  // Atomic: the sources the scene shows are in the room before it changes.
  const deadline = Date.now() + (deps.readyWaitMs ?? 2000)
  let room = deps.room()
  for (;;) {
    if (!room?.identity) return { ok: false, message: 'The room is not connected.' }
    const cameraReady = !translation.needs.camera || room.cameraPublished || room.cameraOff
    const screenReady =
      !translation.needs.screen || room.screenPublished || room.stage.screen !== undefined
    if (cameraReady && screenReady) break
    if (Date.now() >= deadline)
      return {
        ok: false,
        message: !screenReady
          ? 'This scene shows a screen. Share your screen in the room first.'
          : 'This scene shows your camera. Turn the room camera on first.'
      }
    await sleep(100)
    room = deps.room()
  }
  // The scene's screen box shows the stage's screen: the host's, unless a
  // guest's is already up. Guests and who is on stage never change here (D7).
  if (translation.needs.screen && room.stage.screen === undefined && room.screenPublished) {
    try {
      await deps.setStage({ ...room.stage, screen: room.identity })
    } catch (error) {
      return {
        ok: false,
        message: `The room's screen couldn't be put up: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    room = deps.room()
    if (!room?.identity) return { ok: false, message: 'The room is not connected.' }
  }
  if (deps.current && !deps.current())
    return {
      ok: false,
      commit: { state: 'superseded', reason: 'A newer change replaced this one.', observed: {} },
      orientation
    }
  const commit = await room.commitScene({
    h: orientation === 'h' ? translation.scene : null,
    v: orientation === 'v' ? translation.scene : null,
    transition: deps.animate
      ? { kind: 'motion', durationMs: SCENE_MOTION_MS }
      : { kind: 'cut', durationMs: 0 }
  })
  const ok = commit.state === 'applied' || commit.state === 'preview'
  return { ok, message: roomSceneMessage(commit), commit, orientation }
}

/** A Show stage layout replaces the scene: the room's own layouts return. */
export function stageLayoutClearsScene(
  previous: CloudStage | undefined,
  next: CloudStage
): boolean {
  return previous !== undefined && previous.layout !== next.layout
}
