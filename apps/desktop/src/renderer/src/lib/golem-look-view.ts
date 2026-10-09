import type {
  AiCapabilities,
  CohostAvatarDraft,
  CohostAvatarRedoState,
  CohostAvatarState,
  CohostPersona
} from './backend'
import type { EntitlementUiGate } from './entitlement-ui'
import {
  GOLEM_GENERATE_CONSENT_OFF,
  GOLEM_GENERATE_NOT_AVAILABLE,
  GOLEM_GENERATE_QUOTA,
  GOLEM_GENERATE_SIGNED_OUT
} from './golem-persona-view'

// "Your Golem's look" (plan 169 D13): pure derivations the panel and its
// tests share.

/** The web route's description bound (D4). */
export const GOLEM_LOOK_DESCRIPTION_MAX_CHARS = 600
/** A new look is four pictures off the daily image cap (D6); a redo is one. */
export const GOLEM_LOOK_CREATE_IMAGES = 4
export const GOLEM_LOOK_REDO_STATES: readonly CohostAvatarRedoState[] = ['talk', 'laugh', 'think']

export const GOLEM_LOOK_DESCRIPTION_PLACEHOLDER = 'A grumpy stone golem with a mossy back…'
export const GOLEM_LOOK_PICTURE_HINT = 'Add a picture for inspiration: a pet, a logo, a sketch'

export function isGolemLookRedoState(state: CohostAvatarState): state is CohostAvatarRedoState {
  return (GOLEM_LOOK_REDO_STATES as readonly string[]).includes(state)
}

export interface GolemLookAvailability {
  /** Create my Golem (and Try again) work. */
  allowed: boolean
  /** Redo works (one image left is enough). */
  redoAllowed: boolean
  /** The one tertiary line when Create does not work; null when it does. */
  reason: string | null
  /** Today's remaining images, when the web reported them. */
  remaining: number | null
}

/**
 * Whether the look can be made for this account (plan 169 D13; the plan 164
 * hints): signed in, Premium, cloud AI allowed, a web that offers the route,
 * and enough of today's images (a set uses 4, a redo 1). The checks run in
 * the order a streamer can fix them.
 */
export function golemLookAvailability({
  signedIn,
  gate,
  consented,
  capabilities
}: {
  signedIn: boolean
  gate: EntitlementUiGate
  consented: boolean
  capabilities: Pick<AiCapabilities, 'cohost'> | null
}): GolemLookAvailability {
  const avatar = capabilities?.cohost?.avatar
  const remaining = avatar?.enabled ? avatar.remainingToday : null
  const off = (reason: string): GolemLookAvailability => ({
    allowed: false,
    redoAllowed: false,
    reason,
    remaining
  })
  if (!signedIn) return off(GOLEM_GENERATE_SIGNED_OUT)
  if (!gate.allowed) return off(gate.reason)
  if (!consented) return off(GOLEM_GENERATE_CONSENT_OFF)
  if (!avatar?.enabled) return off(GOLEM_GENERATE_NOT_AVAILABLE)
  if (avatar.remainingToday <= 0) return off(GOLEM_GENERATE_QUOTA)
  if (avatar.remainingToday < GOLEM_LOOK_CREATE_IMAGES) {
    return {
      allowed: false,
      redoAllowed: true,
      reason: `A new look uses ${GOLEM_LOOK_CREATE_IMAGES} images; ${golemImagesCount(avatar.remainingToday)} left today.`,
      remaining
    }
  }
  return { allowed: true, redoAllowed: true, reason: null, remaining }
}

function golemImagesCount(count: number): string {
  return `${count} ${count === 1 ? 'image' : 'images'}`
}

/** "24 images left today · uses 4": the tertiary line beside Create. */
export function golemLookAllowanceCopy(remaining: number): string {
  return `${golemImagesCount(remaining)} left today · uses ${GOLEM_LOOK_CREATE_IMAGES}`
}

/**
 * The draft's pictures as `stillImages` for the tiles and the living
 * preview. `revision` is added as `?v=` so a redone picture (same path)
 * loads fresh; main serves the path and ignores the query.
 */
export function golemLookDraftImages(
  draft: CohostAvatarDraft,
  revision: number
): CohostPersona['images'] {
  const images: CohostPersona['images'] = {}
  for (const [state, path] of Object.entries(draft.images) as [CohostAvatarState, string][]) {
    images[state] = revision > 0 ? `${path}?v=${revision}` : path
  }
  return images
}

// --- The inspiration picture (plan 169 D13, Phase A's request cap) ----------

/** What the drop zone takes, before anything is decoded. */
export const GOLEM_LOOK_PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export const GOLEM_LOOK_PICTURE_MAX_BYTES = 10 * 1024 * 1024
/** Fit within this many pixels on the longest side before sending. */
export const GOLEM_LOOK_PICTURE_SIDE = 1024
/** Vercel refuses a request body over 4.5 MB and base64 adds a third: the
 * picture sent stays at or under 3 MB (the backend refuses more). */
export const GOLEM_LOOK_SEND_MAX_BYTES = 3 * 1024 * 1024
/** Below this side the picture is no use as inspiration; refuse instead. */
const GOLEM_LOOK_PICTURE_MIN_SIDE = 512
const LOSSY_QUALITIES = [0.9, 0.8, 0.7, 0.6] as const

export const GOLEM_LOOK_PICTURE_TYPE_ERROR = 'Choose a PNG, JPEG or WebP picture.'
export const GOLEM_LOOK_PICTURE_SIZE_ERROR = 'Choose a picture under 10 MB.'
export const GOLEM_LOOK_PICTURE_UNREADABLE = 'That picture could not be read. Try another one.'
export const GOLEM_LOOK_PICTURE_TOO_LARGE =
  'That picture is too large to send, even made smaller. Try another one.'

export interface GolemLookCanvas {
  /** Any pixel not fully opaque. */
  transparent: boolean
  encode: (type: 'image/png' | 'image/webp' | 'image/jpeg', quality?: number) => Promise<Blob>
  close?: () => void
}

export interface GolemLookPictureDeps {
  decode: (
    file: Blob
  ) => Promise<{ width: number; height: number; source: unknown; close?: () => void }>
  /** The decoded picture drawn at `width` × `height`. */
  draw: (source: unknown, width: number, height: number) => Promise<GolemLookCanvas>
  toBase64: (blob: Blob) => Promise<string>
}

export interface GolemLookPicture {
  base64: string
  type: string
  width: number
  height: number
  bytes: number
}

export const defaultGolemLookPictureDeps: GolemLookPictureDeps = {
  decode: async (file) => {
    const bitmap = await createImageBitmap(file)
    return {
      width: bitmap.width,
      height: bitmap.height,
      source: bitmap,
      close: () => bitmap.close()
    }
  },
  draw: async (source, width, height) => {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error(GOLEM_LOOK_PICTURE_UNREADABLE)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source as CanvasImageSource, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)
    let transparent = false
    for (let index = 3; index < data.length; index += 4) {
      if (data[index]! < 255) {
        transparent = true
        break
      }
    }
    return {
      transparent,
      encode: (type, quality) =>
        canvas.convertToBlob(quality === undefined ? { type } : { type, quality })
    }
  },
  toBase64: (blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
      reader.onerror = () => reject(reader.error ?? new Error(GOLEM_LOOK_PICTURE_UNREADABLE))
      reader.readAsDataURL(blob)
    })
}

/** The size that fits `width` × `height` within `side`, never upscaled. */
export function golemLookFit(
  width: number,
  height: number,
  side: number
): { width: number; height: number } {
  const scale = Math.min(1, side / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/**
 * The inspiration picture as the backend takes it (plan 169 D13, Phase A):
 * fitted within 1024 px, then a PNG when it has transparency and stays
 * under 3 MB, else WebP (transparent) or JPEG (opaque) at quality 0.9,
 * stepping the quality and then the size down until it fits. Refused with a
 * plain line only when it cannot get under 3 MB.
 */
export async function prepareGolemLookPicture(
  file: Blob,
  deps: GolemLookPictureDeps = defaultGolemLookPictureDeps
): Promise<GolemLookPicture> {
  if (!(GOLEM_LOOK_PICTURE_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(GOLEM_LOOK_PICTURE_TYPE_ERROR)
  }
  if (file.size > GOLEM_LOOK_PICTURE_MAX_BYTES) throw new Error(GOLEM_LOOK_PICTURE_SIZE_ERROR)
  let decoded: Awaited<ReturnType<GolemLookPictureDeps['decode']>>
  try {
    decoded = await deps.decode(file)
  } catch {
    throw new Error(GOLEM_LOOK_PICTURE_UNREADABLE)
  }
  try {
    if (!decoded.width || !decoded.height) throw new Error(GOLEM_LOOK_PICTURE_UNREADABLE)
    const finish = async (blob: Blob, width: number, height: number) => ({
      base64: await deps.toBase64(blob),
      type: blob.type,
      width,
      height,
      bytes: blob.size
    })
    for (
      let side = GOLEM_LOOK_PICTURE_SIDE;
      side >= GOLEM_LOOK_PICTURE_MIN_SIDE;
      side = Math.floor(side * 0.8)
    ) {
      const { width, height } = golemLookFit(decoded.width, decoded.height, side)
      const canvas = await deps.draw(decoded.source, width, height)
      try {
        if (canvas.transparent && side === GOLEM_LOOK_PICTURE_SIDE) {
          const png = await canvas.encode('image/png')
          if (png.size <= GOLEM_LOOK_SEND_MAX_BYTES) return await finish(png, width, height)
        }
        const type = canvas.transparent ? 'image/webp' : 'image/jpeg'
        for (const quality of LOSSY_QUALITIES) {
          const blob = await canvas.encode(type, quality)
          if (blob.size <= GOLEM_LOOK_SEND_MAX_BYTES) return await finish(blob, width, height)
        }
      } finally {
        canvas.close?.()
      }
      // Already smaller than the side: only the quality could help, and it did not.
      if (Math.max(decoded.width, decoded.height) <= side * 0.8) break
    }
    throw new Error(GOLEM_LOOK_PICTURE_TOO_LARGE)
  } finally {
    decoded.close?.()
  }
}
