// The live background catalogue (plan 190): names and looks, from React Bits'
// own presets. The backend owns it (crates/videorc-backend/src/
// live_background/looks.rs); `live-background-catalog.test.ts` pins this copy
// to the generated `live-backgrounds.catalog.generated.json`.
//
// Not in the eager bundle: the Assets page (lazy) and the main process read it.

import {
  LIVE_BACKGROUND_IDS,
  livePosterAssetId,
  livePosterFileName,
  type LiveBackgroundId
} from './live-background-ids'

export type LiveBackgroundLook = { id: string; name: string }
export type LiveBackgroundEntry = {
  id: LiveBackgroundId
  name: string
  looks: readonly LiveBackgroundLook[]
}

export const LIVE_BACKGROUND_CATALOG: readonly LiveBackgroundEntry[] = [
  {
    id: 'silk',
    name: 'Silk',
    looks: [
      { id: 'satin', name: 'Satin' },
      { id: 'champagne', name: 'Champagne' },
      { id: 'midnight', name: 'Midnight' }
    ]
  },
  {
    id: 'side-rays',
    name: 'Side Rays',
    looks: [
      { id: 'sunbeam', name: 'Sunbeam' },
      { id: 'moonlight', name: 'Moonlight' },
      { id: 'spotlight', name: 'Spotlight' }
    ]
  },
  {
    id: 'plasma-wave',
    name: 'Plasma Wave',
    looks: [
      { id: 'plasma', name: 'Plasma' },
      { id: 'ember', name: 'Ember' },
      { id: 'glacier', name: 'Glacier' }
    ]
  },
  {
    id: 'liquid-chrome',
    name: 'Liquid Chrome',
    looks: [
      { id: 'polished', name: 'Polished' },
      { id: 'gold', name: 'Gold' },
      { id: 'mercury', name: 'Mercury' }
    ]
  },
  {
    id: 'line-waves',
    name: 'Line Waves',
    looks: [
      { id: 'silk', name: 'Silk' },
      { id: 'gold', name: 'Gold' },
      { id: 'aurora', name: 'Aurora' }
    ]
  },
  // Plan 194 (N4): the five more, after the first five.
  {
    id: 'beams',
    name: 'Beams',
    looks: [
      { id: 'studio', name: 'Studio' },
      { id: 'chrome', name: 'Chrome' },
      { id: 'ember', name: 'Ember' }
    ]
  },
  {
    id: 'color-bends',
    name: 'Color Bends',
    looks: [
      { id: 'default', name: 'Default' },
      { id: 'ember', name: 'Ember' },
      { id: 'ocean', name: 'Ocean' }
    ]
  },
  {
    id: 'dither',
    name: 'Dither',
    looks: [
      { id: 'classic', name: 'Classic' },
      { id: 'amber', name: 'Amber' },
      { id: 'blueprint', name: 'Blueprint' }
    ]
  },
  {
    id: 'ferrofluid',
    name: 'Ferrofluid',
    looks: [
      { id: 'studio', name: 'Studio' },
      { id: 'ember', name: 'Ember' },
      { id: 'frost', name: 'Frost' }
    ]
  },
  {
    id: 'ghost-fibers',
    name: 'Ghost Fibers',
    looks: [
      { id: 'violet', name: 'Violet' },
      { id: 'fiber', name: 'Fiber Optic' },
      { id: 'ember', name: 'Ember' }
    ]
  }
]

export function liveBackgroundEntry(id: LiveBackgroundId): LiveBackgroundEntry {
  return LIVE_BACKGROUND_CATALOG.find((entry) => entry.id === id) ?? LIVE_BACKGROUND_CATALOG[0]
}

/** Every look's bundled poster, for main's managed-asset registration. */
export function livePosterManifest(): { id: string; name: string; fileName: string }[] {
  return LIVE_BACKGROUND_IDS.flatMap((id) => {
    const entry = liveBackgroundEntry(id)
    return entry.looks.map((look) => ({
      id: livePosterAssetId(id, look.id),
      name: `${entry.name} · ${look.name}`,
      fileName: livePosterFileName(id, look.id)
    }))
  })
}
