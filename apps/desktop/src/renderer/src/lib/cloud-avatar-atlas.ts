import type {
  AnimatorAvatarState,
  AnimatorPack,
  AnimatorSettings
} from '../../../shared/buddy-animator'
import {
  AVATAR_ATLAS_MAX_CELLS,
  parseAvatarAtlasMeta,
  type AvatarAtlasMeta
} from '../../../shared/cloud-avatar-atlas-meta'
import {
  atlasLayerRect,
  type MotionInputs,
  type MotionOrientation,
  type MotionRect
} from '../../../shared/cloud-avatar-motion'
import { BUDDY_PET_TALK_IDS } from './buddy-pet-player'
import { CloudAvatarAtlasRefusal } from './cloud-avatar-refusal'
import type { BuddyPreviewImage, BuddyPreviewPack } from './buddy-pet-preview-pack'

/**
 * Plan 249 S5: the worn pack as one atlas PNG for a cloud output, plus the
 * meta the program's animator twin needs (ids, kinds, gaze points, pivot,
 * head top, talk frames) and where each cell sits in the PNG.
 *
 * Bounded inside S4's static limits, never relaxing them: at most 1024 x 1024
 * pixels and 256 KiB of base64 per PNG. Frames drawing the same source cell
 * share one atlas cell (as the compositor's atlas). A pack that cannot fit at
 * `ATLAS_MIN_CELL_PX` is refused, so the room keeps S4's static avatar
 * instead of shipping blurred or oversized art.
 */
export const ATLAS_MAX_SIDE_PX = 1024
export const ATLAS_MAX_BASE64 = 256 * 1024
/** The sharpest cell sent: a 1080p output draws the Buddy at about this size. */
export const ATLAS_MAX_CELL_PX = 256
export const ATLAS_MIN_CELL_PX = 64

export interface CloudAvatarAtlas {
  png: string
  width: number
  height: number
  hash: string
  meta: AvatarAtlasMeta
  /** The animator's view of the same pack (meta without rects). */
  pack: AnimatorPack
}

export interface AtlasCanvas {
  drawCell(
    image: BuddyPreviewImage,
    rect: readonly number[],
    box: readonly number[],
    at: [number, number, number]
  ): void
  /** Base64 PNG of everything drawn so far; `null` when encoding failed. */
  encode(): Promise<string | null>
}

export interface CloudAvatarAtlasDeps {
  canvas(width: number, height: number): AtlasCanvas | null
  hash(bytes: Uint8Array<ArrayBuffer>): Promise<string>
}

/** The grid for `count` cells at the largest cell side that fits. */
export function atlasGrid(
  count: number,
  cellPx: number
): { cols: number; rows: number; cellPx: number } {
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const side = Math.min(
    cellPx,
    Math.floor(ATLAS_MAX_SIDE_PX / cols),
    Math.floor(ATLAS_MAX_SIDE_PX / rows)
  )
  return { cols, rows, cellPx: side }
}

export async function buildCloudAvatarAtlas(
  pack: BuddyPreviewPack,
  deps: CloudAvatarAtlasDeps
): Promise<CloudAvatarAtlas> {
  if (pack.frames.length > AVATAR_ATLAS_MAX_CELLS)
    throw new CloudAvatarAtlasRefusal(
      'The avatar shows still on cloud outputs: it has too many frames to animate there.'
    )
  // One atlas cell per distinct source cell (image + rect + box).
  const imageIds = new Map<unknown, number>()
  const unique = new Map<string, number>()
  const cellOf = new Map<string, number>()
  const sources: { image: BuddyPreviewImage; rect: readonly number[]; box: readonly number[] }[] =
    []
  for (const frame of pack.frames) {
    const cell = pack.cells.get(frame.id)
    if (!cell) throw new Error(`Avatar frame ${frame.id} has no image.`)
    if (!imageIds.has(cell.image.source)) imageIds.set(cell.image.source, imageIds.size)
    const key = `${imageIds.get(cell.image.source)}|${cell.rect.join(',')}|${cell.box.join(',')}`
    if (!unique.has(key)) {
      unique.set(key, sources.length)
      sources.push({ image: cell.image, rect: cell.rect, box: cell.box })
    }
    cellOf.set(frame.id, unique.get(key)!)
  }
  const reactionIds = new Set(pack.frames.filter((f) => f.kind === 'reaction').map((f) => f.id))
  const animatorPack: AnimatorPack = {
    neutral: pack.neutral,
    pivot: [pack.pivot[0], pack.pivot[1]],
    headTop: Math.min(1, Math.max(0, pack.headTop)),
    talk: BUDDY_PET_TALK_IDS.filter((id) => reactionIds.has(id)),
    cells: pack.frames.map((frame) => ({
      id: frame.id,
      kind: frame.kind,
      gaze: frame.kind === 'gaze' && frame.gaze ? [frame.gaze[0], frame.gaze[1]] : null
    }))
  }
  let cellPx = atlasGrid(sources.length, ATLAS_MAX_CELL_PX).cellPx
  while (cellPx >= ATLAS_MIN_CELL_PX) {
    const grid = atlasGrid(sources.length, cellPx)
    const width = grid.cols * grid.cellPx
    const height = grid.rows * grid.cellPx
    const canvas = deps.canvas(width, height)
    if (!canvas) throw new Error('Avatar canvas unavailable')
    const origin = (index: number): [number, number] => [
      (index % grid.cols) * grid.cellPx,
      Math.floor(index / grid.cols) * grid.cellPx
    ]
    sources.forEach((source, index) =>
      canvas.drawCell(source.image, source.rect, source.box, [...origin(index), grid.cellPx])
    )
    const png = await canvas.encode()
    if (!png) throw new Error('Avatar atlas raster failed')
    if (png.length <= ATLAS_MAX_BASE64) {
      const metaRaw = {
        ...animatorPack,
        cells: animatorPack.cells.map((cell) => ({
          ...cell,
          rect: [...origin(cellOf.get(cell.id)!), grid.cellPx, grid.cellPx]
        }))
      }
      const meta = parseAvatarAtlasMeta(metaRaw, { width, height })
      if (!meta) throw new Error('Avatar atlas is not a valid cloud pack')
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      return { png, width, height, hash: await deps.hash(bytes), meta, pack: animatorPack }
    }
    cellPx = Math.floor(grid.cellPx * 0.8)
  }
  throw new CloudAvatarAtlasRefusal(
    'The avatar shows still on cloud outputs: it is too detailed to animate there.'
  )
}

/** The browser's canvas and encoder (OffscreenCanvas, straight alpha, PNG). */
export function browserAtlasCanvas(width: number, height: number): AtlasCanvas | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return {
    drawCell(image, rect, box, [x, y, side]) {
      context.drawImage(
        image.source,
        rect[0],
        rect[1],
        rect[2],
        rect[3],
        x + box[0] * side,
        y + box[1] * side,
        box[2] * side,
        box[3] * side
      )
    },
    async encode() {
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    }
  }
}

// --- The room's animated variant (plan 249 S5) ------------------------------------------

type AtlasLayer = import('../../../shared/cloud-avatar').AvatarLayer
type Orientations<T> = Record<MotionOrientation, T>

let atlasCache: { key: string; atlas: Promise<CloudAvatarAtlas> } | null = null

/** One atlas per worn pack: a bubble or state change never re-encodes the sheet. */
export function cachedCloudAvatarAtlas(
  persona: { id: string; packId: string },
  load: () => Promise<CloudAvatarAtlas>
): Promise<CloudAvatarAtlas> {
  const key = `${persona.id}\u0000${persona.packId}`
  if (atlasCache?.key !== key) {
    const atlas = load()
    atlasCache = { key, atlas }
    atlas.catch(() => {
      if (atlasCache?.atlas === atlas) atlasCache = null
    })
  }
  return atlasCache.atlas
}

/**
 * The animated variant of S4's content: per orientation the atlas as the
 * avatar layer (its rect the compositor's square box) plus S4's own bubble
 * layer, and the seed the motion stream starts from. Nothing private: the
 * pack's public frames, layout rects and the persona's motion settings. No
 * card: the room adds the cards each output accepted (`TalkShowRoomClient`).
 */
export function animatedAvatarContent(params: {
  atlas: CloudAvatarAtlas
  staticLayers: Orientations<AtlasLayer[]>
  layout: Orientations<MotionRect>
  settings: AnimatorSettings
  avatarState: AnimatorAvatarState
}): {
  animated: Orientations<AtlasLayer[]>
  seed: { settings: AnimatorSettings; inputs: MotionInputs }
} {
  const { atlas } = params
  const layers = (orientation: MotionOrientation): AtlasLayer[] => [
    {
      kind: 'avatar',
      rect: atlasLayerRect(params.layout[orientation], orientation),
      asset: { png: atlas.png, hash: atlas.hash, width: atlas.width, height: atlas.height },
      expiresAt: null,
      atlas: atlas.meta
    },
    ...params.staticLayers[orientation].filter((layer) => layer.kind === 'bubble')
  ]
  return {
    animated: { h: layers('h'), v: layers('v') },
    seed: {
      settings: { ...params.settings },
      inputs: {
        avatarState: params.avatarState,
        rects: { ...params.layout },
        cards: { h: null, v: null },
        atlasHash: atlas.hash,
        pack: atlas.pack
      }
    }
  }
}
