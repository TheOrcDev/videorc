import type { CloudPresentationRestore } from '@/lib/backend'
import { parseAvatarAtlasMeta } from '../../../shared/cloud-avatar-atlas-meta'
import type { AvatarLayer } from '../../../shared/cloud-avatar'
import type { GraphicsContent } from '../../../shared/cloud-graphics'
import type { AvatarContent } from './room-avatar-publisher'

type KeptView = CloudPresentationRestore['views'][number]

/**
 * Plan 249 S24 (D9): the avatar a show kept, as this controller re-sends it
 * under its own delivery envelope after a takeover. Only the avatar layer
 * itself, never a bubble (the cloud keeps none); `null` when nothing usable
 * came back. Each orientation takes the stream view, else the recording one.
 *
 * Plan 249 S5: a view an animation consumer applied kept its atlas layer.
 * It comes back as `animated` (sent to `animation: 1` pages only), with no
 * motion: those pages draw the atlas's neutral cell at rest until this
 * computer's own animator runs. Motion, reactions and talk are never kept.
 * An atlas that no longer matches its PNG is dropped, not drawn as a still.
 */
export function restoredAvatarContent(restore: CloudPresentationRestore): AvatarContent | null {
  const views = restore.views.filter((view) => view.topic === 'avatar')
  const avatarLayers = (view: KeptView | undefined, atlas: boolean): AvatarLayer[] =>
    (view?.layers ?? []).flatMap((layer) => {
      if (layer.kind !== 'avatar' || typeof layer.asset.png !== 'string') return []
      const size = { width: layer.asset.width, height: layer.asset.height }
      const meta = layer.atlas === undefined ? null : parseAvatarAtlasMeta(layer.atlas, size)
      if (atlas !== (layer.atlas !== undefined) || (atlas && !meta)) return []
      return [
        {
          kind: 'avatar' as const,
          rect: layer.rect,
          asset: { hash: layer.asset.hash, png: layer.asset.png, ...size },
          expiresAt: null,
          ...(meta ? { atlas: meta } : {})
        }
      ]
    })
  const pick = (orientation: 'h' | 'v', atlas: boolean): AvatarLayer[] => {
    for (const output of ['stream', 'recording'] as const) {
      const layers = avatarLayers(
        views.find((v) => v.orientation === orientation && v.output === output),
        atlas
      )
      if (layers.length > 0) return layers
    }
    return []
  }
  // A view kept for an output the controller has since turned the avatar
  // off on stays off: the output flags carry over, the pixels follow them.
  const shown = (output: 'stream' | 'recording') =>
    restore.outputs?.avatar?.[output] !== false &&
    views.some((view) => view.output === output && view.layers.some((l) => l.kind === 'avatar'))
  const animated = { h: pick('h', true), v: pick('v', true) }
  const content: AvatarContent = {
    h: pick('h', false),
    v: pick('v', false),
    stream: shown('stream'),
    recording: shown('recording'),
    ...(animated.h.length + animated.v.length > 0 ? { animated } : {})
  }
  return content.h.length + content.v.length + animated.h.length + animated.v.length > 0
    ? content
    : null
}

type RestoredBanner = GraphicsContent['h'][number]

/**
 * Plan 249 S24 (D9) with S9: the banners a show kept, as S9 graphics
 * content for this controller to put back. Only banners (the cloud keeps no
 * chat, caption or card); each output only where the kept view had it and
 * the controller's banner output flag is not off. At rest: no fade, no
 * expiry. At most four per orientation, S9's bound. `null`: nothing usable.
 */
export function restoredGraphicsContent(restore: CloudPresentationRestore): GraphicsContent | null {
  const views = restore.views.filter((view) => view.topic === 'static')
  const flags = (restore.outputs as { banners?: { stream?: boolean; recording?: boolean } })
    ?.banners
  const orientation = (side: 'h' | 'v'): RestoredBanner[] => {
    const banners = new Map<string, RestoredBanner>()
    for (const output of ['stream', 'recording'] as const) {
      if (flags?.[output] === false) continue
      const view = views.find((v) => v.orientation === side && v.output === output)
      for (const layer of view?.layers ?? []) {
        if (layer.kind !== 'banner' || typeof layer.asset.png !== 'string' || !layer.id) continue
        const known = banners.get(layer.id)
        if (known) {
          known[output] = true
          if (known.rect.x !== layer.rect.x || known.rect.y !== layer.rect.y)
            known.outputRects = { stream: known.rect, recording: layer.rect }
          continue
        }
        if (banners.size >= 4) continue
        banners.set(layer.id, {
          id: layer.id,
          kind: 'banner',
          rect: layer.rect,
          asset: {
            png: layer.asset.png,
            hash: layer.asset.hash,
            width: layer.asset.width,
            height: layer.asset.height
          },
          opacity: Math.min(1, Math.max(0, layer.opacity ?? 1)),
          fade: null,
          expiresAt: null,
          stream: output === 'stream',
          recording: output === 'recording'
        })
      }
    }
    return [...banners.values()]
  }
  const content: GraphicsContent = { h: orientation('h'), v: orientation('v'), unsupported: [] }
  return content.h.length + content.v.length > 0 ? content : null
}
