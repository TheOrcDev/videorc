import type { CloudRoomStatus } from '@/lib/backend'
import type { RoomSceneStatus } from '@/lib/room-scene-publisher'
import { managedProgramStageInput } from '@/lib/talk-show-managed'
import {
  planSceneTiles,
  scenePicture,
  type SceneCanvas,
  type SceneTile
} from '../../../shared/cloud-scene'
import type { BackgroundStillReason } from '../../../shared/cloud-background'

/**
 * Plan 249 S12: the host's scene in the Program preview, with the program
 * page's own rules. The tiles come from the shared `planSceneTiles` on the
 * horizontal lane's scene, for the people and the screen the page reports
 * drawing (S6's `managedProgramStageInput`, the same roster the Program
 * preview already uses); each picture from the shared `scenePicture`. No
 * layout is worked out here. Pure: no DOM, no React.
 */

/** The Program preview's canvas: the horizontal stream lane. */
export const SCENE_PREVIEW_CANVAS: SceneCanvas = { width: 1920, height: 1080 }

export type ScenePreview = { sceneId: string; tiles: SceneTile[] }

/**
 * The scene the horizontal program draws, or null when it draws the room's
 * own layouts: scenes off in this room, a clear, or a vertical-only scene.
 */
export function programScenePreview(
  status: RoomSceneStatus | undefined,
  room: CloudRoomStatus | undefined,
  hostIdentity: string | null
): ScenePreview | null {
  const scene = status?.enabled ? status.content?.h : null
  if (!scene || !hostIdentity) return null
  const drawn = managedProgramStageInput(room)
  return {
    sceneId: scene.id,
    tiles: planSceneTiles(scene, SCENE_PREVIEW_CANVAS, {
      host: hostIdentity,
      guests: drawn.people.filter((identity) => identity !== hostIdentity),
      hostOnStage: drawn.people.includes(hostIdentity),
      screen: drawn.screen ?? null
    })
  }
}

export type PercentBox = { left: string; top: string; width: string; height: string }
const percent = (part: number, whole: number): string => `${(part / whole) * 100}%`

/**
 * Where a scene tile's picture goes, in percent so it scales with the frame:
 * `clip` (what shows: the frame for cover, the picture for contain) within
 * the tile, and `full` (the whole uncropped source at its own shape, placed so
 * its crop lands on the picture) within the clip. Unknown source size: the
 * tile's own shape, so nothing is cut or letterboxed.
 */
export function scenePreviewPicture(
  tile: Pick<SceneTile, 'rect' | 'crop' | 'fit'>,
  source: { w: number; h: number } | null
): { clip: PercentBox; full: PercentBox } {
  const { w, h } = tile.rect
  const { clip, full } = scenePicture(
    { x: 0, y: 0, w, h },
    source && source.w > 2 && source.h > 2 ? source : { w, h },
    tile.crop,
    tile.fit
  )
  return {
    clip: {
      left: percent(clip.x, w),
      top: percent(clip.y, h),
      width: percent(clip.w, w),
      height: percent(clip.h, h)
    },
    full: {
      left: percent(full.x - clip.x, clip.w),
      top: percent(full.y - clip.y, clip.h),
      width: percent(full.w, clip.w),
      height: percent(full.h, clip.h)
    }
  }
}

/**
 * The scene's line under the Program preview: what the outputs confirmed,
 * never more. Null while the room shows its own layouts.
 */
export function sceneStatusLine(status: RoomSceneStatus | undefined): string | null {
  if (!status?.enabled) return null
  const line = (() => {
    switch (status.state) {
      case 'applied':
        return 'Scene drawn by each output · Preview reconstruction'
      case 'preview':
        return 'Scene set · Shows once the stream or recording starts'
      case 'failed':
        return status.reason ?? "The scene couldn't be sent to the program."
      default:
        return status.reason ?? 'Scene sent · Output unconfirmed'
    }
  })()
  const background = backgroundNote(status)
  return background ? `${line} · ${background}` : line
}

const STILL_COPY: Record<BackgroundStillReason, string> = {
  'no-webgl2': 'the output cannot animate it',
  'shader-compile-failed': "the animation didn't start on the output",
  'context-lost': 'the output lost its graphics',
  'gpu-budget': 'the output is too busy to animate it',
  'unknown-look': "the output doesn't know this look",
  'asset-missing': "the picture hasn't arrived",
  'asset-invalid': 'the output refused the picture'
}

/**
 * Plan 249 S14: what the outputs said about the scene's background, only
 * when it is not simply drawn. A still poster is never reported as moving.
 */
export function backgroundNote(status: RoomSceneStatus | undefined): string | null {
  const background = status?.background
  if (!background) return null
  if (background.unsupported > 0) return 'Background unconfirmed: reload older program pages'
  for (const drawn of Object.values(background.drawn))
    if (drawn.reason) return `Background shows still: ${STILL_COPY[drawn.reason]}`
  return null
}
