import { AvatarReceiver, avatarPng, type AvatarLayer, type AvatarSnapshot } from './cloud-avatar'

/** The same accepted raster/geometry renderer in monitor and program. */
export function createAvatarView(root: HTMLElement, now: () => number = Date.now) {
  type Prepared = { image: HTMLImageElement; url: string }
  let shown: { asset: Prepared; until: number | null }[] = []
  const discard = (asset: Prepared) => {
    asset.image.remove()
    asset.image.removeAttribute('src')
    URL.revokeObjectURL(asset.url)
  }
  const clear = () => {
    shown.forEach((s) => discard(s.asset))
    shown = []
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
