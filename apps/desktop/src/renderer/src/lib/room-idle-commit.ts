import type {
  CompositorStatus,
  LayoutSettings,
  Scene,
  SceneCommitStatus,
  SourceSelection,
  VideoSettings
} from '@/lib/backend'
import { verticalOrientationVideoPatch, type CaptureConfig } from '@/lib/capture'
import type { SceneApp } from '@/lib/scene-presets'
import { withoutSceneApp } from '@/lib/scene-window-state'

/**
 * A native scene commit while a talk-show room holds the camera.
 *
 * The room borrows the camera for its life (plan 224 D6) and the backend
 * refuses every native start of it. A native layout transaction
 * (`scene.layout.apply_preview`) composes that camera, so it waited out the
 * camera's 15 s start budget and failed: a background picked in Assets while a
 * room was open never changed (live test 3, 2026-11-20), and the background
 * the room camera is keyed onto follows the committed working background.
 *
 * Nothing native is on air in a room, so every native change there commits
 * idle: `scene.load_from_capture_config` sets scene state and compositor
 * config only (no capture start, no camera wait, no preview proof). The
 * Studio then takes the same working-state update a native transaction makes.
 * Two callers: a native transaction made in a room (a background, a look, an
 * undo), and the alignment after a scene went to the room program (plan 249
 * S12). Lazy: it rides in the room scene adapter's chunk.
 */

/** The Studio's working state, read when the commit is asked for. */
export type IdleCommitState = {
  config: CaptureConfig
  background: Scene['background'] | null | undefined
  app: SceneApp | undefined
  origin: 'builtin' | 'saved'
}

/** What the working state takes from the commit besides the scene itself. */
export type IdleCommitRest = {
  captureConfigPatch?: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'>
  origin?: 'builtin' | 'saved'
  sceneApp?: SceneApp
  savedSceneId?: string | null
  /** Putting a scene on stream, never an edit that saves into it. */
  sceneSwitch?: boolean
}

export type IdleCommit = {
  params: {
    sources: SourceSelection
    layout: LayoutSettings
    video: VideoSettings
    background?: NonNullable<Scene['background']>
  }
  rest: IdleCommitRest
}

/** The committed scene as the Studio's working-state update reads it. */
export type IdleCommitSnapshot = IdleCommitRest & {
  sceneRevision: number
  scene: Scene
  layout: LayoutSettings
  compositorStatus: CompositorStatus
  sources: SourceSelection
}

/** The parts of a native layout transaction's options an idle commit keeps. */
export type IdleTransactionOptions = {
  videoOverride?: VideoSettings
  captureConfigPatch?: Pick<CaptureConfig, 'video' | 'verticalRestoreVideo'>
  backgroundOverride?: Scene['background'] | null
  savedSceneId?: string | null
  origin?: 'builtin' | 'saved'
}

/**
 * A native layout transaction made while the room holds the camera: the
 * layout asked for over the working sources, with the background the
 * transaction names (`backgroundOverride`, where null takes it off) or else
 * the working one. An edit of the scene on stream, so it saves into it.
 */
export function roomTransactionCommit(
  state: IdleCommitState,
  layout: LayoutSettings,
  options: IdleTransactionOptions | undefined
): IdleCommit {
  const background =
    options && 'backgroundOverride' in options ? options.backgroundOverride : state.background
  return {
    params: {
      sources: state.config.sources,
      layout,
      video: options?.videoOverride ?? state.config.video,
      ...(background ? { background } : {})
    },
    rest: {
      captureConfigPatch: options?.captureConfigPatch,
      sceneApp: state.app,
      savedSceneId: options?.savedSceneId,
      origin: options?.origin ?? state.origin
    }
  }
}

/**
 * The native working scene follows the scene put on the room program (plan
 * 249 S12): the same working-state update a native switch makes, with the
 * orientation's canvas, so the Scene editor acts on the scene viewers see and
 * the Preview shows it when the room closes.
 */
export function roomAlignmentCommit(
  state: IdleCommitState,
  target: {
    layout: LayoutSettings
    sources: SourceSelection
    background: Scene['background'] | null
  },
  savedSceneId: string | null
): IdleCommit {
  const { config } = state
  const coupling = verticalOrientationVideoPatch(
    config.layout.layoutPreset,
    target.layout.layoutPreset,
    config.video,
    config.verticalRestoreVideo
  )
  return {
    params: {
      sources: withoutSceneApp(target.sources),
      layout: target.layout,
      video: coupling?.video ?? config.video,
      ...(target.background ? { background: target.background } : {})
    },
    rest: {
      origin: savedSceneId ? 'saved' : 'builtin',
      savedSceneId,
      sceneSwitch: true,
      ...(coupling
        ? {
            captureConfigPatch: {
              video: coupling.video,
              verticalRestoreVideo: coupling.verticalRestoreVideo
            }
          }
        : {})
    }
  }
}

/** Commits it idle and answers the snapshot the working state takes. */
export async function commitSceneIdle(
  client: { request<T>(method: string, params?: unknown): Promise<T> },
  commit: IdleCommit
): Promise<IdleCommitSnapshot> {
  const status = await client.request<SceneCommitStatus>(
    'scene.load_from_capture_config',
    commit.params
  )
  return {
    sceneRevision: status.sceneRevision,
    scene: status.scene,
    layout: commit.params.layout,
    compositorStatus: status.compositorStatus,
    sources: commit.params.sources,
    ...commit.rest
  }
}
