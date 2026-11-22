// PH-05 and PH-06 (the 11-20 performance hunt): the view of static graphics
// (the desktop's Program preview and, mirrored, the on-air program page).
// A caption update is a new snapshot about twice a second. The view used to
// throw every image away and decode and append all of them again; it now keeps
// the image of a layer whose pixels did not change.
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../../protocol-fixtures/cloud-parity-graphics.json'
import { createGraphicsView } from './cloud-graphics-view'
import type { GraphicsAsset, GraphicsLayer, GraphicsSnapshot } from './cloud-graphics'

/** Just enough of an element for the view: children in order, and a count of insertions. */
class FakeElement {
  children: FakeElement[] = []
  parent: FakeElement | null = null
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  alt = ''
  src = ''
  naturalWidth = 1
  naturalHeight = 1
  /** How often this element was put into a parent. */
  inserts = 0
  constructor(readonly ownerDocument: FakeDocument) {}
  get lastElementChild(): FakeElement | null {
    return this.children.at(-1) ?? null
  }
  insertBefore(node: FakeElement, before: FakeElement | null): FakeElement {
    node.remove()
    const at = before ? this.children.indexOf(before) : this.children.length
    this.children.splice(at, 0, node)
    node.parent = this
    node.inserts++
    return node
  }
  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.insertBefore(node, null)
  }
  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of [...this.children]) child.remove()
    this.append(...nodes)
  }
  remove(): void {
    if (!this.parent) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = null
  }
  removeAttribute(name: string): void {
    if (name === 'src') this.src = ''
  }
  decode(): Promise<void> {
    this.ownerDocument.decodes.push(this.src)
    return Promise.resolve()
  }
}
class FakeDocument {
  images: FakeElement[] = []
  decodes: string[] = []
  createElement(): FakeElement {
    const image = new FakeElement(this)
    this.images.push(image)
    return image
  }
}

const dot = Buffer.from(fixture.snapshot.layers[0]!.asset.png, 'base64')
/** A static PNG with bytes (and so a hash) of its own: the fixture plus a text chunk. */
function picture(note: string): GraphicsAsset {
  const text = Buffer.from(`Comment\0${note}`, 'latin1')
  const chunk = Buffer.alloc(12 + text.length)
  chunk.writeUInt32BE(text.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  text.copy(chunk, 8)
  const bytes = Buffer.concat([
    dot.subarray(0, dot.length - 12),
    chunk,
    dot.subarray(dot.length - 12)
  ])
  return {
    png: bytes.toString('base64'),
    hash: createHash('sha256').update(bytes).digest('hex'),
    width: 1,
    height: 1
  }
}
const layer = (
  id: string,
  kind: GraphicsLayer['kind'],
  asset: GraphicsAsset,
  patch: Partial<GraphicsLayer> = {}
): GraphicsLayer => ({
  id,
  kind,
  rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.15 },
  asset,
  opacity: 1,
  fade: null,
  expiresAt: kind === 'caption' || kind === 'highlight' ? 20_000 : null,
  ...patch
})
const snapshot = (revision: number, layers: GraphicsLayer[]): GraphicsSnapshot => ({
  version: 1,
  show: 'sh_graphics',
  publisherSid: 'PA_host',
  revision,
  output: 'stream',
  orientation: 'h',
  expiresAt: 30_000,
  layers
})

function harness() {
  const page = new FakeDocument()
  const slots = {
    banner: new FakeElement(page),
    caption: new FakeElement(page),
    chat: new FakeElement(page),
    highlight: new FakeElement(page)
  }
  const clock = { now: 1000 }
  const view = createGraphicsView(
    slots as unknown as Parameters<typeof createGraphicsView>[0],
    () => clock.now
  )
  view.receiver.owner('PA_host')
  const ids = (slot: FakeElement) => slot.children.map((image) => image.dataset.graphicsId)
  return { page, slots, clock, view, ids }
}

describe('the static graphics view keeps what did not change (PH-05, PH-06)', () => {
  let revoked: string[] = []
  beforeEach(() => {
    revoked = []
    const revoke = URL.revokeObjectURL.bind(URL)
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => {
      revoked.push(url)
      revoke(url)
    })
    vi.stubGlobal('requestAnimationFrame', (run: () => void) => setTimeout(run, 0))
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a caption update decodes the caption only and leaves the other images where they are', async () => {
    const h = harness()
    const banner = layer('banner:a', 'banner', picture('view banner'))
    const chat = layer('chat', 'chat', picture('view chat'))
    const caption = (n: number) => layer('caption', 'caption', picture(`view caption ${n}`))
    expect(await h.view.receiver.accept(snapshot(1, [banner, caption(1), chat]))).toBe(true)
    expect(h.page.images).toHaveLength(3)
    const bannerImage = h.slots.banner.children[0]!
    const chatImage = h.slots.chat.children[0]!
    const captionUrls = [h.slots.caption.children[0]!.src]
    for (let n = 2; n <= 31; n++) {
      expect(await h.view.receiver.accept(snapshot(n, [banner, caption(n), chat]))).toBe(true)
      captionUrls.push(h.slots.caption.children[0]!.src)
    }
    // Thirty caption updates: thirty new images, all of them captions.
    expect(h.page.images).toHaveLength(33)
    expect(h.page.decodes).toHaveLength(33)
    expect(h.slots.banner.children).toEqual([bannerImage])
    expect(h.slots.chat.children).toEqual([chatImage])
    expect(h.slots.caption.children).toHaveLength(1)
    expect(h.slots.caption.children[0]!.dataset.graphicsId).toBe('caption')
    // The kept images were put into the page once, and never taken out.
    expect(bannerImage.inserts).toBe(1)
    expect(chatImage.inserts).toBe(1)
    expect(bannerImage.src).not.toBe('')
    // Every replaced caption released its picture; nothing else did.
    expect(revoked).toEqual(captionUrls.slice(0, -1))
    expect(h.view.receiver.applied).toEqual({ publisherSid: 'PA_host', revision: 31 })
    h.view.close()
    expect(revoked).toHaveLength(33)
    expect(Object.values(h.slots).every((slot) => slot.children.length === 0)).toBe(true)
  })

  it('a kept image follows its layer: moved, restyled, reordered, and gone when the layer is', async () => {
    const h = harness()
    const first = layer('banner:a', 'banner', picture('order banner a'))
    const second = layer('banner:b', 'banner', picture('order banner b'))
    const third = layer('banner:c', 'banner', picture('order banner c'))
    expect(await h.view.receiver.accept(snapshot(1, [first, second]))).toBe(true)
    const [a, b] = h.slots.banner.children as [FakeElement, FakeElement]
    expect(h.ids(h.slots.banner)).toEqual(['banner:a', 'banner:b'])
    // Placement and opacity change: the same images, restyled in place.
    const moved = { ...second, rect: { x: 0.5, y: 0.6, w: 0.25, h: 0.2 }, opacity: 0.5 }
    expect(await h.view.receiver.accept(snapshot(2, [first, moved]))).toBe(true)
    expect(h.slots.banner.children).toEqual([a, b])
    expect(b.style).toMatchObject({ left: '50%', top: '60%', width: '25%', height: '20%' })
    expect(b.style.opacity).toBe('0.5')
    expect([a.inserts, b.inserts]).toEqual([1, 1])
    // The order changes and a banner joins: one move, one new image.
    expect(await h.view.receiver.accept(snapshot(3, [moved, third, first]))).toBe(true)
    expect(h.ids(h.slots.banner)).toEqual(['banner:b', 'banner:c', 'banner:a'])
    expect(h.slots.banner.children[0]).toBe(b)
    expect(h.slots.banner.children[2]).toBe(a)
    expect(h.page.images).toHaveLength(3)
    // A banner leaves: its image and picture go, the others stay.
    expect(await h.view.receiver.accept(snapshot(4, [moved, third]))).toBe(true)
    expect(h.ids(h.slots.banner)).toEqual(['banner:b', 'banner:c'])
    expect(revoked).toHaveLength(1)
    expect(a.parent).toBeNull()
    expect(a.src).toBe('')
    // Other pixels under the same id: a new image replaces the old one.
    const repainted = { ...moved, asset: picture('order banner b again') }
    expect(await h.view.receiver.accept(snapshot(5, [repainted, third]))).toBe(true)
    expect(h.slots.banner.children[0]).not.toBe(b)
    expect(h.ids(h.slots.banner)).toEqual(['banner:b', 'banner:c'])
    expect(b.parent).toBeNull()
    expect(revoked).toHaveLength(2)
    expect(h.page.images).toHaveLength(4)
  })

  it('an expired layer leaves by itself and is decoded again if it comes back', async () => {
    const h = harness()
    const banner = layer('banner:a', 'banner', picture('expiry banner'))
    const card = layer('highlight', 'highlight', picture('expiry card'), { expiresAt: 5000 })
    expect(await h.view.receiver.accept(snapshot(1, [banner, card]))).toBe(true)
    const bannerImage = h.slots.banner.children[0]!
    h.clock.now = 5000
    h.view.step()
    expect(h.slots.highlight.children).toHaveLength(0)
    expect(revoked).toHaveLength(1)
    // The same card again, with a later expiry: it is not on screen, so it is decoded.
    const again = { ...card, expiresAt: 9000 }
    expect(await h.view.receiver.accept(snapshot(2, [banner, again]))).toBe(true)
    expect(h.page.images).toHaveLength(3)
    expect(h.slots.highlight.children).toHaveLength(1)
    expect(h.slots.banner.children).toEqual([bannerImage])
    // A snapshot whose kept layer has expired by the time it is shown drops it.
    h.clock.now = 9500
    const late = { ...again, expiresAt: 9400 }
    expect(await h.view.receiver.accept(snapshot(3, [banner, late]))).toBe(true)
    expect(h.slots.highlight.children).toHaveLength(0)
    expect(h.slots.banner.children).toEqual([bannerImage])
    expect(revoked).toHaveLength(2)
    // An owner change clears everything.
    h.view.receiver.owner('PA_other')
    expect(h.slots.banner.children).toHaveLength(0)
    expect(revoked).toHaveLength(3)
  })
})
