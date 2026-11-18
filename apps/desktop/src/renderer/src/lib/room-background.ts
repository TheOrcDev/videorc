import type { EffectiveSceneBackground } from '@/lib/backend'
import { backgroundAssetDisplayUrl } from '@/lib/background-library'
import {
  BACKGROUND_ASSET_MAX_BYTES,
  BACKGROUND_ASSET_MAX_SIDE,
  backgroundFit,
  backgroundZoomCrop,
  hexOf,
  isLiveBackgroundId,
  liveBackgroundDim,
  nextLiveClock,
  type BackgroundMime,
  type LiveBackground,
  type SceneBackground
} from '../../../shared/cloud-background'
import type { PreparedBackgroundAsset } from './room-scene-publisher'

/**
 * Plan 249 S14. The native scene background as the room program draws it.
 * Lazy (only the scene adapter loads it). A picture is decoded, drawn down to
 * at most `BACKGROUND_ASSET_MAX_SIDE`, encoded (WebP, JPEG where the encoder
 * has no WebP) under `BACKGROUND_ASSET_MAX_BYTES` and named by its SHA-256;
 * a live background is the shader's id, look, Dim and one phase clock that
 * continues across look and motion changes without a jump, as natively.
 */
export type PreparedBackground = {
  background: SceneBackground
  asset?: PreparedBackgroundAsset
}
export type ClockSpec = { rate: number; posterPhase: number }

export type RoomBackgroundDeps = {
  /** The look's clock constants (the backend's render export); null: unknown look. */
  clockSpec(id: string, look: string): ClockSpec | null
  /** Decode, draw down and encode a picture. */
  encodePicture(
    url: string
  ): Promise<{ bytes: Uint8Array; mime: BackgroundMime; width: number; height: number }>
  digest(bytes: Uint8Array): Promise<ArrayBuffer>
  now(): number
}

export function pictureSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, BACKGROUND_ASSET_MAX_SIDE / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

export function createRoomBackgrounds(deps: RoomBackgroundDeps): {
  prepare(background: EffectiveSceneBackground): Promise<PreparedBackground>
} {
  let live: { id: string; clock: LiveBackground['clock'] } | null = null
  const pictures = new Map<string, Promise<PreparedBackgroundAsset>>()
  return {
    async prepare(background) {
      if (background.live) {
        const { id, look, motion } = background.live
        if (!isLiveBackgroundId(id)) throw new Error('This live background is not known here.')
        const spec = deps.clockSpec(id, look)
        if (!spec) throw new Error("This live background's look is not known here.")
        const rate = spec.rate * (motion === 'calm' ? 0.5 : 1)
        const clock = nextLiveClock(live, { id, rate, posterPhase: spec.posterPhase }, deps.now())
        live = { id, clock }
        return {
          background: {
            kind: 'live',
            id,
            look,
            dim: liveBackgroundDim(background.dimPercent),
            clock
          }
        }
      }
      const key = `${background.assetId}|${background.managedAssetPath}`
      let pending = pictures.get(key)
      if (!pending) {
        pending = (async () => {
          const picture = await deps.encodePicture(
            backgroundAssetDisplayUrl(background.managedAssetPath)
          )
          if (picture.bytes.length > BACKGROUND_ASSET_MAX_BYTES)
            throw new Error('The background picture is too large to send.')
          return { ...picture, hash: hexOf(await deps.digest(picture.bytes)) }
        })()
        // One picture at a time: a new one replaces the old.
        pictures.clear()
        pictures.set(key, pending)
        pending.catch(() => pictures.delete(key))
      }
      const asset = await pending
      return {
        background: {
          kind: 'picture',
          hash: asset.hash,
          mime: asset.mime,
          width: asset.width,
          height: asset.height,
          fit: backgroundFit(background.fit),
          crop: backgroundZoomCrop(background.scale, background.offsetX, background.offsetY)
        },
        asset
      }
    }
  }
}

/** The browser picture encoder: an `<img>` (the asset protocol), a canvas, WebP or JPEG. */
export async function encodePictureInBrowser(
  url: string
): Promise<{ bytes: Uint8Array; mime: BackgroundMime; width: number; height: number }> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  const size = pictureSize(image.naturalWidth, image.naturalHeight)
  const canvas = new OffscreenCanvas(size.width, size.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error("The background picture couldn't be drawn.")
  context.drawImage(image, 0, 0, size.width, size.height)
  for (const quality of [0.9, 0.8, 0.7, 0.55]) {
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    if (blob.type !== 'image/webp')
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    if (blob.size <= BACKGROUND_ASSET_MAX_BYTES)
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
        ...size
      }
  }
  throw new Error('The background picture is too large to send.')
}

/** The app's preparer: the backend's render export, the browser encoder, Web Crypto. */
export async function createAppRoomBackgrounds(): Promise<
  ReturnType<typeof createRoomBackgrounds>
> {
  const { liveBackgroundClockSpec } = await import('@/lib/live-background-player')
  return createRoomBackgrounds({
    clockSpec: (id, look) => liveBackgroundClockSpec(id, look, 'normal'),
    encodePicture: encodePictureInBrowser,
    digest: (bytes) => crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
    now: Date.now
  })
}
