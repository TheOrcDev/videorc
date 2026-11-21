import {
  GraphicsReceiver,
  graphicsOpacity,
  sameGraphicsAsset,
  type GraphicsLayer
} from './cloud-graphics'
/** Slots share the native order: banner/chat below avatar, highlight above it. */
export function createGraphicsView(
  slots: { banner: HTMLElement; caption: HTMLElement; chat: HTMLElement; highlight: HTMLElement },
  now: () => number = Date.now
) {
  type Asset = { image: HTMLImageElement; url: string }
  let shown: { asset: Asset; layer: GraphicsLayer }[] = []
  for (const root of Object.values(slots))
    Object.assign(root.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
  const discard = (a: Asset) => {
    a.image.remove()
    a.image.removeAttribute('src')
    URL.revokeObjectURL(a.url)
  }
  const clear = () => {
    shown.forEach((s) => discard(s.asset))
    shown = []
    Object.values(slots).forEach((r) => r.replaceChildren())
  }
  const receiver = new GraphicsReceiver<Asset>({
    now,
    clear,
    discard,
    retain(ids) {
      shown = shown.filter((s) => {
        if (ids.has(s.layer.id)) return true
        discard(s.asset)
        return false
      })
    },
    renew(snapshot) {
      // PERF-06: same pixels and placement; only the expiries move.
      for (const layer of snapshot.layers)
        for (const s of shown) if (s.layer.id === layer.id) s.layer = layer
    },
    kept(layer) {
      // PH-06: this very picture is on screen under this id: keep its image.
      return shown.find(
        (s) =>
          s.layer.id === layer.id &&
          s.layer.kind === layer.kind &&
          sameGraphicsAsset(s.layer.asset, layer.asset)
      )?.asset
    },
    async prepare(layer, bytes) {
      const image = slots.banner.ownerDocument.createElement('img')
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
      image.alt = ''
      image.src = url
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          image.decode(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('Graphic decode timed out')), 5000)
          })
        ])
        if (image.naturalWidth !== layer.asset.width || image.naturalHeight !== layer.asset.height)
          throw Error('Graphic dimensions differ')
        return { image, url }
      } catch (e) {
        discard({ image, url })
        throw e
      } finally {
        clearTimeout(timer)
      }
    },
    async commit(snapshot, assets) {
      // PH-06: an asset the receiver kept is one of `shown`: its image stays
      // where it is (restyled, moved only if the order changed). Everything
      // else on screen goes, as the full clear did before.
      const next: typeof shown = []
      const order = new Map<HTMLElement, HTMLImageElement[]>()
      snapshot.layers.forEach((layer, i) => {
        const asset = assets[i]!
        if (layer.expiresAt !== null && layer.expiresAt <= now()) {
          if (!shown.some((s) => s.asset === asset)) discard(asset)
          return
        }
        Object.assign(asset.image.style, {
          position: 'absolute',
          left: `${layer.rect.x * 100}%`,
          top: `${layer.rect.y * 100}%`,
          width: `${layer.rect.w * 100}%`,
          height: `${layer.rect.h * 100}%`,
          objectFit: 'fill',
          opacity: String(graphicsOpacity(layer, now()))
        })
        asset.image.dataset.graphicsLayer = layer.kind
        asset.image.dataset.graphicsId = layer.id
        const slot = slots[layer.kind]
        order.set(slot, [...(order.get(slot) ?? []), asset.image])
        next.push({ asset, layer })
      })
      for (const s of shown) if (!next.some((n) => n.asset === s.asset)) discard(s.asset)
      shown = next
      for (const slot of Object.values(slots)) {
        const images = order.get(slot) ?? []
        images.forEach((image, i) => {
          const at = slot.children[i]
          if (at !== image) slot.insertBefore(image, at ?? null)
        })
        while (slot.children.length > images.length) slot.lastElementChild!.remove()
      }
      let frame = 0,
        timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            frame = requestAnimationFrame(() => {
              frame = requestAnimationFrame(() => resolve())
            })
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Error('Graphic paint timed out')), 3000)
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
      shown = shown.filter((s) => {
        if (s.layer.expiresAt !== null && s.layer.expiresAt <= now()) {
          discard(s.asset)
          return false
        }
        s.asset.image.style.opacity = String(graphicsOpacity(s.layer, now()))
        return true
      })
    },
    close() {
      receiver.owner(null)
      clear()
    }
  }
}
