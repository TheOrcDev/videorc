import { AvatarReceiver, avatarPng, type AvatarLayer, type AvatarSnapshot } from './cloud-avatar'
import {
  AVATAR_MOTION_CANVAS,
  paintAvatarDraw,
  restingDraw,
  type AvatarAtlasMeta,
  type MotionOrientation
} from './cloud-avatar-motion'
import type { AnimatorDraw } from './buddy-animator'

/**
 * Plan 249 S5: a view that draws atlas layers. Only a consumer that
 * advertised `graphics.animation: 1` is sent one; without `motion` an atlas
 * layer still draws its neutral cell at rest (never the whole sheet).
 *
 * The pose comes from a `MotionReceiver` on a program page, or from the
 * producer's own simulation in the desktop's Program preview: either one
 * draws nothing for an atlas whose hash it does not describe.
 */
export interface AvatarMotionSource {
  advance(): void
  draw(orientation: MotionOrientation, atlasHash: string): AnimatorDraw | null
  readonly sim: { readonly tick: number } | null
}
export type AvatarViewMotion = { receiver: AvatarMotionSource; orientation: MotionOrientation }

/** The same accepted raster/geometry renderer in monitor and program. */
export function createAvatarView(
  root: HTMLElement,
  now: () => number = Date.now,
  motion?: AvatarViewMotion
) {
  type Prepared = { image: HTMLImageElement; url: string }
  let shown: { asset: Prepared; until: number | null }[] = []
  /** The atlas layer on screen, painted every `step()`. */
  let animated: {
    canvas: HTMLCanvasElement
    context: CanvasRenderingContext2D
    image: HTMLImageElement
    meta: AvatarAtlasMeta
    box: AvatarLayer['rect']
    hash: string
    orientation: MotionOrientation
    painted: string
  } | null = null
  const paintAtlas = () => {
    if (!animated) return
    const draw =
      (motion && motion.orientation === animated.orientation
        ? motion.receiver.draw(animated.orientation, animated.hash)
        : null) ?? restingDraw(animated.meta, animated.box, animated.orientation)
    const key = JSON.stringify(draw)
    if (key === animated.painted) {
      animated.canvas.dataset.avatarTick = String(motion?.receiver.sim?.tick ?? 'rest')
      return
    }
    const cell = animated.meta.cells.find((c) => c.id === draw.cell)
    animated.context.setTransform(1, 0, 0, 1, 0, 0)
    animated.context.clearRect(0, 0, animated.canvas.width, animated.canvas.height)
    if (cell) paintAvatarDraw(animated.context, animated.image, cell.rect, draw, 1)
    animated.painted = key
    // Public facts for acceptance: which pack cell at which show tick (never pixels or text).
    animated.canvas.dataset.avatarCell = draw.cell
    animated.canvas.dataset.avatarTick = String(motion?.receiver.sim?.tick ?? 'rest')
  }
  const discard = (asset: Prepared) => {
    asset.image.remove()
    asset.image.removeAttribute('src')
    URL.revokeObjectURL(asset.url)
  }
  const clear = () => {
    shown.forEach((s) => discard(s.asset))
    shown = []
    animated = null
    root.replaceChildren()
  }
  root.style.position = 'absolute'
  root.style.inset = '0'
  root.style.pointerEvents = 'none'
  const receiver = new AvatarReceiver<Prepared>({
    now,
    clear,
    discard,
    async prepare(layer: AvatarLayer) {
      const bytes = avatarPng(layer.asset.png, layer.asset.width, layer.asset.height)
      if (!bytes) throw new Error('Invalid avatar PNG')
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      const image = root.ownerDocument.createElement('img')
      image.alt = ''
      image.src = url
      try {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            image.decode(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Avatar decode timed out')), 5000)
            })
          ])
        } finally {
          clearTimeout(timer)
        }
        if (image.naturalWidth !== layer.asset.width || image.naturalHeight !== layer.asset.height)
          throw new Error('Avatar dimensions differ')
      } catch (error) {
        discard({ image, url })
        throw error
      }
      return { image, url }
    },
    async commit(snapshot: AvatarSnapshot, assets: Prepared[]) {
      clear()
      snapshot.layers.forEach((layer, i) => {
        const asset = assets[i]!
        if (layer.expiresAt !== null && layer.expiresAt <= now()) {
          discard(asset)
          return
        }
        if (layer.kind === 'avatar' && layer.atlas) {
          // The sheet is a source only; the canvas covers the output so
          // motion past the box is never clipped.
          const orientation = motion?.orientation ?? snapshot.orientation
          const [width, height] = AVATAR_MOTION_CANVAS[orientation]
          const canvas = root.ownerDocument.createElement('canvas')
          const context = canvas.getContext('2d')
          if (!context) throw new Error('Avatar canvas unavailable')
          canvas.width = width
          canvas.height = height
          Object.assign(canvas.style, {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%'
          })
          canvas.dataset.avatarLayer = layer.kind
          root.append(canvas)
          shown.push({ asset, until: layer.expiresAt })
          animated = {
            canvas,
            context,
            image: asset.image,
            meta: layer.atlas,
            box: layer.rect,
            hash: layer.asset.hash,
            orientation,
            painted: ''
          }
          paintAtlas()
          return
        }
        Object.assign(asset.image.style, {
          position: 'absolute',
          left: `${layer.rect.x * 100}%`,
          top: `${layer.rect.y * 100}%`,
          width: `${layer.rect.w * 100}%`,
          height: `${layer.rect.h * 100}%`,
          objectFit: 'fill'
        })
        asset.image.dataset.avatarLayer = layer.kind
        root.append(asset.image)
        shown.push({ asset, until: layer.expiresAt })
      })
      // Two frame callbacks cross a paint boundary. A DOM insertion alone is
      // not an applied-output observation; a stopped page must not acknowledge.
      let timer: ReturnType<typeof setTimeout> | undefined
      let frame = 0
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            frame = requestAnimationFrame(() => {
              frame = requestAnimationFrame(() => resolve())
            })
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Avatar paint timed out')), 3000)
          })
        ])
      } finally {
        clearTimeout(timer)
        cancelAnimationFrame(frame)
      }
    }
  })
  return {
    receiver,
    step() {
      receiver.step()
      if (animated && motion) motion.receiver.advance()
      paintAtlas()
      shown = shown.filter((s) => {
        if (s.until !== null && s.until <= now()) {
          discard(s.asset)
          return false
        }
        return true
      })
    },
    close() {
      receiver.owner(null)
      clear()
    }
  }
}
