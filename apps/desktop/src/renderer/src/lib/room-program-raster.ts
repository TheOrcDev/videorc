/**
 * Plan 249 S23 (D10): the Program preview, rasterized for Videorc Camera.
 *
 * The Show stage's Program preview is DOM: tiles of room `<video>`s placed
 * with S6/S12's shared geometry, S9's graphics `<img>`s and S4/S5's avatar
 * `<img>`/`<canvas>` layers, over the video ground. This module draws exactly
 * what that subtree shows into one canvas, from the layout the browser already
 * computed: every visible `<video>`, `<img>` and `<canvas>` at its box with its
 * `object-fit`, mirror, opacity and clip (overflow, rounded corners, the
 * host's circle), and every painted background colour. Text is not drawn (the
 * preview's only text is status copy and camera-off initials).
 *
 * It never reads anything outside the preview, so whatever the preview hides
 * (a packed camera drawn at opacity 0, a screen the program does not show)
 * stays hidden on the camera too.
 */

export type RasterRect = { x: number; y: number; w: number; h: number }
export type RasterClip = { rect: RasterRect; shape: 'rect' | 'ellipse'; radius: number }
type RasterBase = { clips: RasterClip[]; opacity: number; z: number[]; order: number }
export type RasterOp =
  | (RasterBase & { kind: 'fill'; rect: RasterRect; color: string; radius: number })
  | (RasterBase & {
      kind: 'media'
      source: CanvasImageSource
      natural: { w: number; h: number }
      rect: RasterRect
      fit: ObjectFit
      mirror: boolean
    })
export type ObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down'

export type DrawRects = { sx: number; sy: number; sw: number; sh: number } & {
  dx: number
  dy: number
  dw: number
  dh: number
}

/** Where `object-fit` (centred `object-position`) puts a source in a box. */
export function fitSourceRect(
  natural: { w: number; h: number },
  box: RasterRect,
  fit: ObjectFit
): DrawRects | null {
  if (!(natural.w > 0 && natural.h > 0 && box.w > 0 && box.h > 0)) return null
  const full = { sx: 0, sy: 0, sw: natural.w, sh: natural.h }
  if (fit === 'fill') return { ...full, dx: box.x, dy: box.y, dw: box.w, dh: box.h }
  const containScale = Math.min(box.w / natural.w, box.h / natural.h)
  const scale =
    fit === 'cover'
      ? Math.max(box.w / natural.w, box.h / natural.h)
      : fit === 'contain'
        ? containScale
        : fit === 'none'
          ? 1
          : Math.min(1, containScale)
  const dw = natural.w * scale
  const dh = natural.h * scale
  const dx = box.x + (box.w - dw) / 2
  const dy = box.y + (box.h - dh) / 2
  // Crop what falls outside the box (cover, none) so nothing paints past it.
  const left = Math.max(box.x, dx)
  const top = Math.max(box.y, dy)
  const right = Math.min(box.x + box.w, dx + dw)
  const bottom = Math.min(box.y + box.h, dy + dh)
  if (right <= left || bottom <= top) return null
  return {
    sx: (left - dx) / scale,
    sy: (top - dy) / scale,
    sw: (right - left) / scale,
    sh: (bottom - top) / scale,
    dx: left,
    dy: top,
    dw: right - left,
    dh: bottom - top
  }
}

/** CSS stacking, approximated for an absolute-positioned tree: compare the
 * z-index path from the container down, then document order. */
export function compareRasterOrder(a: RasterBase, b: RasterBase): number {
  const length = Math.max(a.z.length, b.z.length)
  for (let i = 0; i < length; i++) {
    const delta = (a.z[i] ?? 0) - (b.z[i] ?? 0)
    if (delta !== 0) return delta
  }
  return a.order - b.order
}

/** A computed `rgb()`/`rgba()` colour's alpha (0 for transparent or unknown). */
export function colourAlpha(colour: string): number {
  if (!colour || colour === 'transparent') return 0
  const match = /^rgba?\(([^)]+)\)$/.exec(colour.trim())
  if (!match) return 1
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 4) return 1
  const alpha = parts[3]!
  const value = alpha.endsWith('%') ? Number(alpha.slice(0, -1)) / 100 : Number(alpha)
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

function px(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function mirrored(transform: string): boolean {
  if (!transform || transform === 'none') return false
  const match = /^matrix\(([^)]+)\)$/.exec(transform)
  if (!match) return false
  const a = Number(match[1]!.split(',')[0])
  return Number.isFinite(a) && a < 0
}

function objectFit(value: string): ObjectFit {
  return value === 'contain' ||
    value === 'cover' ||
    value === 'none' ||
    value === 'scale-down' ||
    value === 'fill'
    ? value
    : 'fill'
}

type Frame = { clips: RasterClip[]; opacity: number; mirror: boolean; z: number[] }

/**
 * The draw list for `container`'s subtree, in canvas pixels (`width` x
 * `height`). The container's own background is the ground; its own rounded
 * corners are not the camera's. Null while the preview is not displayed
 * (no box): nothing is sent, and the camera pauses on its black still.
 */
export function collectRasterOps(
  container: HTMLElement,
  width: number,
  height: number
): { ground: string | null; ops: RasterOp[] } | null {
  const view = container.ownerDocument.defaultView
  if (!view || !container.isConnected) return null
  const origin = container.getBoundingClientRect()
  if (!(origin.width > 0 && origin.height > 0)) return null
  const sx = width / origin.width
  const sy = height / origin.height
  const toCanvas = (rect: DOMRect): RasterRect => ({
    x: (rect.left - origin.left) * sx,
    y: (rect.top - origin.top) * sy,
    w: rect.width * sx,
    h: rect.height * sy
  })
  const groundStyle = view.getComputedStyle(container)
  const ground = colourAlpha(groundStyle.backgroundColor) > 0 ? groundStyle.backgroundColor : null
  const ops: RasterOp[] = []
  let order = 0
  const visit = (element: Element, parent: Frame): void => {
    if (!(element instanceof view.HTMLElement) && !(element instanceof view.SVGElement)) return
    const style = view.getComputedStyle(element)
    if (style.display === 'none') return
    const opacity = parent.opacity * px(style.opacity || '1')
    if (opacity <= 0.001) return
    const rect = toCanvas(element.getBoundingClientRect())
    const positioned = style.position !== 'static'
    const zIndex = positioned && style.zIndex !== 'auto' ? Number(style.zIndex) || 0 : 0
    const z = positioned ? [...parent.z, zIndex] : parent.z
    const mirror = parent.mirror !== mirrored(style.transform)
    const radius = px(style.borderTopLeftRadius) * sx
    const visible = style.visibility !== 'hidden' && rect.w > 0 && rect.h > 0
    if (visible && colourAlpha(style.backgroundColor) > 0)
      ops.push({
        kind: 'fill',
        rect,
        color: style.backgroundColor,
        radius,
        clips: parent.clips,
        opacity,
        z,
        order: order++
      })
    const media = visible ? mediaOf(element, view) : null
    if (media)
      ops.push({
        kind: 'media',
        ...media,
        rect,
        fit: objectFit(style.objectFit),
        mirror,
        clips: parent.clips,
        opacity,
        z,
        order: order++
      })
    const clips = [...parent.clips]
    if (style.clipPath.startsWith('circle(') || style.clipPath.startsWith('ellipse('))
      clips.push({ rect, shape: 'ellipse', radius: 0 })
    else if (style.overflow !== 'visible' || style.overflowX !== 'visible')
      clips.push({ rect, shape: 'rect', radius })
    for (const child of element.children) visit(child, { clips, opacity, mirror, z })
  }
  for (const child of container.children)
    visit(child, { clips: [], opacity: 1, mirror: false, z: [] })
  ops.sort(compareRasterOrder)
  return { ground, ops }
}

function mediaOf(
  element: Element,
  view: Window & typeof globalThis
): { source: CanvasImageSource; natural: { w: number; h: number } } | null {
  if (element instanceof view.HTMLVideoElement) {
    // HAVE_CURRENT_DATA: a frame to draw.
    if (element.readyState < 2 || !(element.videoWidth > 0)) return null
    return { source: element, natural: { w: element.videoWidth, h: element.videoHeight } }
  }
  if (element instanceof view.HTMLImageElement) {
    if (!element.complete || !(element.naturalWidth > 0)) return null
    return { source: element, natural: { w: element.naturalWidth, h: element.naturalHeight } }
  }
  if (element instanceof view.HTMLCanvasElement) {
    if (!(element.width > 0 && element.height > 0)) return null
    return { source: element, natural: { w: element.width, h: element.height } }
  }
  return null
}

function clipPath(context: CanvasRenderingContext2D, clip: RasterClip): void {
  const { x, y, w, h } = clip.rect
  context.beginPath()
  if (clip.shape === 'ellipse') {
    // `circle(closest-side at 50% 50%)`: the inscribed circle.
    const r = Math.min(w, h) / 2
    context.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2)
  } else if (clip.radius > 0) {
    context.roundRect(x, y, w, h, Math.min(clip.radius, w / 2, h / 2))
  } else {
    context.rect(x, y, w, h)
  }
  context.clip()
}

/** Paint the draw list over the ground. Failing sources are skipped, never fatal. */
export function paintRasterOps(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  ground: string | null,
  ops: readonly RasterOp[]
): void {
  context.save()
  context.globalAlpha = 1
  // The canvas is opaque (`alpha: false`): a cleared pixel is black.
  context.clearRect(0, 0, width, height)
  if (ground) {
    context.fillStyle = ground
    context.fillRect(0, 0, width, height)
  }
  context.restore()
  for (const op of ops) {
    context.save()
    try {
      for (const clip of op.clips) clipPath(context, clip)
      context.globalAlpha = op.opacity
      if (op.kind === 'fill') {
        context.fillStyle = op.color
        context.beginPath()
        if (op.radius > 0)
          context.roundRect(
            op.rect.x,
            op.rect.y,
            op.rect.w,
            op.rect.h,
            Math.min(op.radius, op.rect.w / 2, op.rect.h / 2)
          )
        else context.rect(op.rect.x, op.rect.y, op.rect.w, op.rect.h)
        context.fill()
      } else {
        const rects = fitSourceRect(op.natural, op.rect, op.fit)
        if (rects) {
          if (op.mirror) {
            // Flip about the element's own box, as the CSS transform does.
            context.translate(op.rect.x * 2 + op.rect.w, 0)
            context.scale(-1, 1)
          }
          context.drawImage(
            op.source,
            rects.sx,
            rects.sy,
            rects.sw,
            rects.sh,
            rects.dx,
            rects.dy,
            rects.dw,
            rects.dh
          )
        }
      }
    } catch {
      // A source that cannot be drawn this frame (a torn-down track).
    } finally {
      context.restore()
    }
  }
}
