import type { CohostAvatarState, CohostPersona } from '@/lib/backend'
import { GOLEM_DEFAULT_PACK, golemStateImageUrl } from '@/lib/golem-default-pack'
import type { GolemPetPlayerFrame } from '@/lib/golem-pet-player'
import { GOLEM_STILL_PACK_ID } from '@/lib/golem-pet-view'
import { cssMatrix, DEFAULT_PIVOT, type MotionTransform } from '../../../shared/golem-motion'
import {
  GOLEM_PET_CELL_MAX,
  GOLEM_STILL_REACTION_IDS,
  golemPetSheetNames,
  measureGolemPetHeadTop,
  parseGolemPetManifest,
  validateGolemPetSheetSizes,
  type GolemPetSheetPixels,
  type GolemPetSheetSize
} from '../../../shared/golem-pet'

/**
 * Loading a pet pack for the in-app preview (plan 168 S-D1). Every byte
 * comes through main (`readGolemPetFile`, `golem-pets:read`), never over the
 * network; sheets decode with `createImageBitmap`, the manifest and sheet
 * sizes are checked with `shared/golem-pet.ts` (the backend already checked
 * the pixels on import), and each frame is scaled once into its own small
 * square bitmap at the drawn size, so the big atlas is freed at once and
 * the canvas never resamples a 3200 × 5120 sheet per frame.
 *
 * `still` is the persona's four state images as a flat pack, as the backend
 * builds it (`golem_pet::still_pack`, D2): idle is the one gaze cell at
 * `[0, 0]`, talk, laugh and think are reactions that fall back to idle, and
 * without an idle image the bundled default shows. Each image is contained
 * and bottom-aligned in its square cell.
 */

export { GOLEM_STILL_PACK_ID }

export interface GolemPreviewImage {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

/** One frame's drawable: `rect` of `image` drawn into `box` (normalized) of the cell. */
export interface GolemPreviewCell {
  image: GolemPreviewImage
  rect: readonly [number, number, number, number]
  box: readonly [number, number, number, number]
}

export interface GolemPreviewPack {
  packId: string
  name: string
  neutral: string
  pivot: readonly [number, number]
  frames: GolemPetPlayerFrame[]
  cells: ReadonlyMap<string, GolemPreviewCell>
  reactions: string[]
  gazeCount: number
  /**
   * The normalized top of the neutral silhouette in its cell (D16), where a
   * bubble's tail points; 0 when it could not be measured (the backend's
   * fallback too).
   */
  headTop: number
  /** Fallbacks taken while loading (a Still image that would not load). */
  notes: string[]
}

export interface GolemPreviewPackDeps {
  readPackFile: (personaId: string, packId: string, file: string) => Promise<Uint8Array | null>
  decode: (bytes: Uint8Array) => Promise<GolemPreviewImage>
  loadUrl: (url: string) => Promise<GolemPreviewImage>
  /** `rect` of `image` into `box` (normalized) of a `pixelSize` square; null to draw the source as is. */
  scaleCell: (
    image: GolemPreviewImage,
    rect: readonly [number, number, number, number],
    box: readonly [number, number, number, number],
    pixelSize: number
  ) => Promise<GolemPreviewImage | null>
  /** One cell drawn into a `side` square, as RGBA pixels; null when the host cannot read pixels. */
  readCellPixels?: (cell: GolemPreviewCell, side: number) => GolemPetSheetPixels | null
}

export interface GolemPreviewPackRequest {
  personaId: string
  packId: string
  /** The persona's state images (`<personaId>/<state>.<ext>`), for Still. */
  stillImages?: CohostPersona['images']
  /** The cell side to scale to, in device pixels. */
  pixelSize: number
  signal?: AbortSignal
}

const FULL_BOX = [0, 0, 1, 1] as const

function abortError(): Error {
  const error = new Error('The Golem pack load was cancelled.')
  error.name = 'AbortError'
  return error
}

const browserDeps: GolemPreviewPackDeps = {
  readPackFile: async (personaId, packId, file) => {
    const read = window.videorc?.readGolemPetFile
    if (!read) throw new Error('This window cannot read Golem packs.')
    return read(personaId, packId, file)
  },
  decode: async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]))
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close()
    }
  },
  loadUrl: async (url) => {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return { source: image, width: image.naturalWidth, height: image.naturalHeight }
  },
  scaleCell: async (image, rect, box, pixelSize) => {
    if (typeof OffscreenCanvas === 'undefined') return null
    const canvas = new OffscreenCanvas(pixelSize, pixelSize)
    const context = canvas.getContext('2d')
    if (!context) return null
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(
      image.source,
      rect[0],
      rect[1],
      rect[2],
      rect[3],
      box[0] * pixelSize,
      box[1] * pixelSize,
      box[2] * pixelSize,
      box[3] * pixelSize
    )
    const bitmap = canvas.transferToImageBitmap()
    return { source: bitmap, width: pixelSize, height: pixelSize, close: () => bitmap.close() }
  },
  readCellPixels: (cell, side) => {
    if (typeof OffscreenCanvas === 'undefined') return null
    const canvas = new OffscreenCanvas(side, side)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(
      cell.image.source,
      cell.rect[0],
      cell.rect[1],
      cell.rect[2],
      cell.rect[3],
      cell.box[0] * side,
      cell.box[1] * side,
      cell.box[2] * side,
      cell.box[3] * side
    )
    const pixels = context.getImageData(0, 0, side, side)
    return { width: side, height: side, data: pixels.data }
  }
}

/** The side the head top is measured at: 1/256 of the cell is plenty for a bubble anchor. */
const HEAD_TOP_SIDE = 256

/**
 * D16's head top of a loaded neutral cell, by the shared rule
 * (`measureGolemPetHeadTop`: the first row with alpha above 16), or 0.
 */
export function measureGolemPreviewHeadTop(
  cell: GolemPreviewCell | undefined,
  readCellPixels: GolemPreviewPackDeps['readCellPixels']
): number {
  if (!cell || !readCellPixels) return 0
  const pixels = readCellPixels(cell, HEAD_TOP_SIDE)
  if (!pixels) return 0
  const sheet = 'cell.png'
  return (
    measureGolemPetHeadTop(
      {
        version: 1,
        name: 'cell',
        neutral: 'neutral',
        frames: [
          {
            id: 'neutral',
            kind: 'gaze',
            sheet,
            rect: [0, 0, pixels.width, pixels.height],
            gaze: [0, 0]
          }
        ]
      },
      new Map([[sheet, pixels]])
    ) ?? 0
  )
}

/** The square cell an image is contained in, bottom-aligned (`contain_bottom`). */
export function containBottomBox(
  width: number,
  height: number
): readonly [number, number, number, number] {
  const side = Math.max(width, height, 1)
  const w = width / side
  const h = height / side
  return [(1 - w) / 2, 1 - h, w, h]
}

function clampPixelSize(pixelSize: number): number {
  return Math.max(1, Math.min(GOLEM_PET_CELL_MAX, Math.ceil(pixelSize)))
}

/** Release every bitmap the pack holds. */
export function disposeGolemPreviewPack(pack: GolemPreviewPack | null): void {
  if (!pack) return
  const closed = new Set<GolemPreviewImage>()
  for (const cell of pack.cells.values()) {
    if (closed.has(cell.image)) continue
    closed.add(cell.image)
    cell.image.close?.()
  }
}

/**
 * Scale each frame into its own cell. A source that cannot be scaled is
 * kept and drawn as is; every other source is closed once its frames are cut.
 */
async function cutCells(
  frames: {
    id: string
    image: GolemPreviewImage
    rect: GolemPreviewCell['rect']
    box: GolemPreviewCell['box']
  }[],
  pixelSize: number,
  deps: GolemPreviewPackDeps,
  signal: AbortSignal | undefined
): Promise<Map<string, GolemPreviewCell>> {
  const cells = new Map<string, GolemPreviewCell>()
  const kept = new Set<GolemPreviewImage>()
  const sources = new Set(frames.map((frame) => frame.image))
  try {
    for (const frame of frames) {
      if (signal?.aborted) throw abortError()
      const scaled = await deps.scaleCell(frame.image, frame.rect, frame.box, pixelSize)
      if (scaled) {
        cells.set(frame.id, { image: scaled, rect: [0, 0, pixelSize, pixelSize], box: FULL_BOX })
      } else {
        kept.add(frame.image)
        cells.set(frame.id, { image: frame.image, rect: frame.rect, box: frame.box })
      }
    }
    if (signal?.aborted) throw abortError()
  } catch (error) {
    for (const cell of cells.values()) if (!sources.has(cell.image)) cell.image.close?.()
    for (const source of sources) source.close?.()
    throw error
  }
  for (const source of sources) if (!kept.has(source)) source.close?.()
  return cells
}

async function loadPetPack(
  request: GolemPreviewPackRequest,
  deps: GolemPreviewPackDeps
): Promise<GolemPreviewPack> {
  const { personaId, packId, signal } = request
  const manifestBytes = await deps.readPackFile(personaId, packId, 'manifest.json')
  if (signal?.aborted) throw abortError()
  if (!manifestBytes) throw new Error('This pack has no manifest.json. Import it again.')
  const manifest = parseGolemPetManifest(new TextDecoder().decode(manifestBytes))
  const sheets = new Map<string, GolemPreviewImage>()
  try {
    for (const name of golemPetSheetNames(manifest)) {
      const bytes = await deps.readPackFile(personaId, packId, name)
      if (signal?.aborted) throw abortError()
      if (!bytes) throw new Error(`This pack is missing ${name}. Import it again.`)
      sheets.set(name, await deps.decode(bytes))
      if (signal?.aborted) throw abortError()
    }
    const sizes = new Map<string, GolemPetSheetSize>(
      [...sheets].map(([name, image]) => [name, { width: image.width, height: image.height }])
    )
    validateGolemPetSheetSizes(manifest, sizes)
  } catch (error) {
    for (const image of sheets.values()) image.close?.()
    throw error
  }
  const cells = await cutCells(
    manifest.frames.map((frame) => ({
      id: frame.id,
      image: sheets.get(frame.sheet)!,
      rect: frame.rect,
      box: FULL_BOX
    })),
    clampPixelSize(request.pixelSize),
    deps,
    signal
  )
  return {
    packId,
    name: manifest.name,
    neutral: manifest.neutral,
    pivot: manifest.pivot ?? DEFAULT_PIVOT,
    frames: manifest.frames.map((frame) =>
      frame.gaze
        ? { id: frame.id, kind: frame.kind, gaze: frame.gaze }
        : { id: frame.id, kind: frame.kind }
    ),
    cells,
    reactions: manifest.frames
      .filter((frame) => frame.kind === 'reaction')
      .map((frame) => frame.id),
    gazeCount: manifest.frames.filter((frame) => frame.kind === 'gaze').length,
    headTop: measureGolemPreviewHeadTop(cells.get(manifest.neutral), deps.readCellPixels),
    notes: []
  }
}

async function loadStillPack(
  request: GolemPreviewPackRequest,
  deps: GolemPreviewPackDeps
): Promise<GolemPreviewPack> {
  const { signal } = request
  const images = request.stillImages ?? {}
  const notes: string[] = []
  const byUrl = new Map<string, GolemPreviewImage>()
  const load = async (url: string): Promise<GolemPreviewImage> => {
    const known = byUrl.get(url)
    if (known) return known
    const image = await deps.loadUrl(url)
    byUrl.set(url, image)
    return image
  }
  const persona = { images, source: 'uploaded' as const }
  const states: CohostAvatarState[] = ['idle', ...GOLEM_STILL_REACTION_IDS]
  const idleUrl = golemStateImageUrl(persona, 'idle')
  const loaded = new Map<CohostAvatarState, GolemPreviewImage>()
  try {
    for (const state of states) {
      const url = golemStateImageUrl(persona, state)
      // A state without its own image is the idle cell, whatever idle became.
      if (state !== 'idle' && url === idleUrl) {
        loaded.set(state, loaded.get('idle')!)
        continue
      }
      try {
        loaded.set(state, await load(url))
      } catch {
        // The backend's still pack falls back the same way: idle to the
        // default Golem, every other state to idle.
        notes.push(
          `The ${state} image would not load; the ${state === 'idle' ? 'default Golem' : 'idle image'} shows instead.`
        )
        loaded.set(
          state,
          state === 'idle' ? await load(GOLEM_DEFAULT_PACK.idle) : loaded.get('idle')!
        )
      }
      if (signal?.aborted) throw abortError()
    }
  } catch (error) {
    for (const image of byUrl.values()) image.close?.()
    throw error
  }
  const cells = await cutCells(
    states.map((state) => {
      const image = loaded.get(state)!
      return {
        id: state,
        image,
        rect: [0, 0, image.width, image.height] as const,
        box: containBottomBox(image.width, image.height)
      }
    }),
    clampPixelSize(request.pixelSize),
    deps,
    signal
  )
  return {
    packId: GOLEM_STILL_PACK_ID,
    name: 'Still',
    neutral: 'idle',
    pivot: DEFAULT_PIVOT,
    frames: [
      { id: 'idle', kind: 'gaze', gaze: [0, 0] },
      ...GOLEM_STILL_REACTION_IDS.map((id) => ({ id, kind: 'reaction' as const }))
    ],
    cells,
    reactions: [...GOLEM_STILL_REACTION_IDS],
    gazeCount: 1,
    headTop: measureGolemPreviewHeadTop(cells.get('idle'), deps.readCellPixels),
    notes
  }
}

/** Load `packId` (`still` or a pack id) for the preview. Throws a plain reason. */
export async function loadGolemPreviewPack(
  request: GolemPreviewPackRequest,
  deps: Partial<GolemPreviewPackDeps> = {}
): Promise<GolemPreviewPack> {
  const resolved = { ...browserDeps, ...deps }
  return request.packId === GOLEM_STILL_PACK_ID
    ? loadStillPack(request, resolved)
    : loadPetPack(request, resolved)
}

/** The 2D context calls the preview makes, so tests can record them. */
export type GolemPreviewContext = Pick<
  CanvasRenderingContext2D,
  'setTransform' | 'transform' | 'translate' | 'clearRect' | 'drawImage'
> & {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
}

/**
 * Draw one frame: clear the canvas, then the cell with the motion
 * transform (`cssMatrix`) about `pivot × size`, the cell's box sitting
 * `margin` CSS pixels in from the canvas edge so motion is never clipped.
 */
export function drawGolemPreviewFrame(
  context: GolemPreviewContext,
  canvas: { width: number; height: number },
  cell: GolemPreviewCell | undefined,
  transform: MotionTransform,
  layout: { size: number; margin: number; dpr: number }
): void {
  const { size, margin, dpr } = layout
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, canvas.width, canvas.height)
  if (!cell) return
  const [a, b, c, d, e, f] = cssMatrix(transform)
  const pivotX = transform.pivot[0] * size
  const pivotY = transform.pivot[1] * size
  context.setTransform(dpr, 0, 0, dpr, dpr * margin, dpr * margin)
  context.translate(pivotX, pivotY)
  context.transform(a, b, c, d, e, f)
  context.translate(-pivotX, -pivotY)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    cell.image.source,
    cell.rect[0],
    cell.rect[1],
    cell.rect[2],
    cell.rect[3],
    cell.box[0] * size,
    cell.box[1] * size,
    cell.box[2] * size,
    cell.box[3] * size
  )
}
