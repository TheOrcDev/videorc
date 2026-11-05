import type { CompositorSceneSourceStatus, SceneSource } from '@/lib/backend'
import type { PixelSize } from '../../../shared/scene-picture-geometry'

/**
 * What the renderer knows of each scene source's picture size (plan 216 B2),
 * so the Scene stage can draw a source's box on its picture
 * (`scenePictureRect`). The compositor's status names each scene source's
 * size (the authority: it is what the compositor fits); the capture statuses
 * are the fallback before the compositor reports, by kind. Both are kept
 * here as plain state that changes only when a size does, so the Scene page
 * never re-renders on a status tick.
 */
export interface SourcePictureSizes {
  /** By scene source id, from the compositor's `sceneSources`. */
  byId: Readonly<Record<string, PixelSize>>
  /** The screen or window capture's frame size, from `preview.screen.status`. */
  screen: PixelSize | null
  /** The camera's frame size, from `preview.camera.status`. */
  camera: PixelSize | null
}

export const NO_SOURCE_PICTURE_SIZES: SourcePictureSizes = Object.freeze({
  byId: Object.freeze({}),
  screen: null,
  camera: null
})

const sameSize = (a: PixelSize | null, b: PixelSize | null): boolean =>
  a === b || (a !== null && b !== null && a.width === b.width && a.height === b.height)

const sizeOf = (status: { width?: number; height?: number }): PixelSize | null =>
  status.width !== undefined && status.height !== undefined && status.width > 0 && status.height > 0
    ? { width: status.width, height: status.height }
    : null

/**
 * The sizes after a compositor status: every live scene source's own size
 * (the image entries, a screen image or a background, are not sources on
 * the stage). Returns `current` when nothing changed, so React keeps the
 * same state.
 */
export function sourcePictureSizesFromCompositor(
  current: SourcePictureSizes,
  sceneSources: readonly Pick<CompositorSceneSourceStatus, 'id' | 'kind' | 'width' | 'height'>[]
): SourcePictureSizes {
  const byId: Record<string, PixelSize> = {}
  for (const source of sceneSources) {
    if (source.kind === 'screen-image' || source.kind === 'background-image') continue
    const size = sizeOf(source)
    if (size) byId[source.id] = size
  }
  const ids = Object.keys(byId)
  const currentIds = Object.keys(current.byId)
  if (
    ids.length === currentIds.length &&
    ids.every((id) => sameSize(byId[id] ?? null, current.byId[id] ?? null))
  )
    return current
  return { ...current, byId }
}

/** The sizes after a capture status: the kind's frame size, when it has one. */
export function sourcePictureSizesFromCapture(
  current: SourcePictureSizes,
  kind: 'screen' | 'camera',
  status: { width?: number; height?: number }
): SourcePictureSizes {
  const size = sizeOf(status)
  if (sameSize(current[kind], size)) return current
  return { ...current, [kind]: size }
}

/** A scene source's picture size: its own from the compositor, else its kind's capture. */
export function sourcePictureSize(
  source: Pick<SceneSource, 'id' | 'kind'>,
  sizes: SourcePictureSizes
): PixelSize | null {
  const own = sizes.byId[source.id]
  if (own) return own
  if (source.kind === 'camera') return sizes.camera
  if (source.kind === 'screen' || source.kind === 'window') return sizes.screen
  return null
}

/** The stage's `sourceSizes` prop: every scene source with a known size, by id. */
export function scenePictureSizes(
  sources: readonly Pick<SceneSource, 'id' | 'kind'>[],
  sizes: SourcePictureSizes
): Record<string, PixelSize> {
  const result: Record<string, PixelSize> = {}
  for (const source of sources) {
    const size = sourcePictureSize(source, sizes)
    if (size) result[source.id] = size
  }
  return result
}
