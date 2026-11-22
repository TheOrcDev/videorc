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
import { sceneExtensionForOrientation } from '@/lib/scene-guest-roles'
import type {
  PreparedBackgroundAsset,
  RoomSceneCommit,
  SceneContent
} from '@/lib/room-scene-publisher'
import {
  roomScreenNeedsSwitch,
  roomScreenWant,
  type RoomScreenWant
} from '@/lib/room-screen-source'
import type { SceneBackground } from '../../../shared/cloud-background'
import { SCENE_MOTION_MS, type SceneOrientation } from '../../../shared/cloud-scene'

// The native commit a room makes rides in this lazy chunk.
export * from '@/lib/room-idle-commit'

/**
 * Plan 249 S12: the active-output scene adapter. While a room holds the
 * camera, a scene command (click, hotkey, remote, agent, Follow) changes the
 * room program instead of the native session: the native engine resolves
 * the scene without committing it (no capture start, no camera-lend wait),
 * the result is translated, the sources it shows must be in the room, and
 * only then is it committed to every lane at once. The answer names what the
 * outputs confirmed; nothing is reported applied that was not drawn.
 */

/** A scene command while scenes are off in this room (per room, off by default). */
export const ROOM_SCENES_OFF = 'Scenes are off in this room. The room layouts stay on the program.'
/** Its toast action: turn scenes on for this room and run the command again. */
export const USE_SCENES = 'Use scenes'

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
  /** S14: the capturer source the room shares, null when none or unknown. */
  screenSourceId?: string | null
  stage: CloudStage
  commitScene(
    content: SceneContent | null,
    assets?: readonly PreparedBackgroundAsset[]
  ): Promise<RoomSceneCommit>
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
  /**
   * Plan 249 S14: share the scene's own screen or window in the room before
   * the scene changes (main is told the source, then the room swaps its
   * privacy-gated capture). Throws when the source cannot be shared; the old
   * share then stays and the scene is not committed.
   */
  shareScreen?(want: Extract<RoomScreenWant, { kind: 'source' }>): Promise<void>
  /** Plan 249 S14: the scene's background as the program draws it. */
  background?(
    background: EffectiveSceneBackground
  ): Promise<{ background: SceneBackground; asset?: PreparedBackgroundAsset }>
}

export type RoomSceneResult = {
  ok: boolean
  message?: string
  commit?: RoomSceneCommit
  orientation?: SceneOrientation
  /** S14: what happened to the room's screen share. */
  screen?: 'kept' | 'switched' | 'unsupported'
  /** S14: the background sent with the scene, or why none was. */
  background?: 'none' | 'sent' | 'failed'
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
    extension: sceneExtensionForOrientation(target.extension, orientation)
  })
  // S14: the scene's own screen or window goes on the room share first, so
  // the screen box shows what the scene names (Follow, an app scene, a
  // display). Transactional: a source that cannot be shared refuses the
  // scene and leaves the current share as it was.
  let screen: RoomSceneResult['screen'] = 'kept'
  let screenNote: string | undefined
  if (translation.needs.screen && deps.shareScreen) {
    const want = roomScreenWant(target.sources)
    const before = deps.room()
    if (want.kind === 'unsupported') {
      screen = 'unsupported'
      screenNote = want.reason
    } else if (
      want.kind === 'source' &&
      roomScreenNeedsSwitch(want, before?.screenSourceId ?? null)
    ) {
      if (!before?.identity) return { ok: false, message: 'The room is not connected.' }
      try {
        await deps.shareScreen(want)
      } catch (error) {
        return {
          ok: false,
          screen: 'kept',
          message: `The scene's ${want.sourceKind === 'window' ? 'window' : 'screen'} couldn't be shared in the room: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      if (deps.current && !deps.current())
        return {
          ok: false,
          screen: 'switched',
          commit: {
            state: 'superseded',
            reason: 'A newer change replaced this one.',
            observed: {}
          },
          orientation
        }
      screen = 'switched'
    }
  }
  // S14: the background, behind every source. A background that cannot be
  // prepared is said, never replaced by a guess; the scene still changes.
  let background: RoomSceneResult['background'] = 'none'
  let backgroundNote: string | undefined
  let assets: PreparedBackgroundAsset[] = []
  let scene = translation.scene
  if (target.background && deps.background) {
    try {
      const prepared = await deps.background(target.background)
      scene = { ...scene, background: prepared.background }
      assets = prepared.asset ? [prepared.asset] : []
      background = 'sent'
    } catch (error) {
      background = 'failed'
      backgroundNote = `The background couldn't be sent to the room: ${error instanceof Error ? error.message : String(error)}`
    }
  }
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
  const commit = await room.commitScene(
    {
      h: orientation === 'h' ? scene : null,
      v: orientation === 'v' ? scene : null,
      transition: deps.animate
        ? { kind: 'motion', durationMs: SCENE_MOTION_MS }
        : { kind: 'cut', durationMs: 0 }
    },
    assets
  )
  const ok = commit.state === 'applied' || commit.state === 'preview'
  const message = [roomSceneMessage(commit), backgroundNote, screenNote].filter(Boolean).join(' ')
  return {
    ok,
    ...(message ? { message } : {}),
    commit,
    orientation,
    screen,
    background
  }
}

/** A Show stage layout replaces the scene: the room's own layouts return. */
export function stageLayoutClearsScene(
  previous: CloudStage | undefined,
  next: CloudStage
): boolean {
  return previous !== undefined && previous.layout !== next.layout
}
