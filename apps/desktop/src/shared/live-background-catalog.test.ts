import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { LIVE_BACKGROUND_CATALOG, livePosterManifest } from './live-background-catalog'
import {
  LIVE_BACKGROUND_DEFAULT_LOOKS,
  LIVE_BACKGROUND_IDS,
  isLiveBackgroundId,
  livePosterAssetId,
  parseLivePosterAssetId
} from './live-background-ids'

type GeneratedCatalog = {
  backgrounds: {
    id: string
    name: string
    looks: { id: string; name: string; posterAssetId: string }[]
  }[]
}

const generated = JSON.parse(
  readFileSync(new URL('./live-backgrounds.catalog.generated.json', import.meta.url), 'utf8')
) as GeneratedCatalog

describe('live background catalogue (plan 190)', () => {
  it('equals the backend catalogue', () => {
    expect(
      LIVE_BACKGROUND_CATALOG.map((entry) => ({
        id: entry.id,
        name: entry.name,
        looks: entry.looks.map((look) => ({
          id: look.id,
          name: look.name,
          posterAssetId: livePosterAssetId(entry.id, look.id)
        }))
      }))
    ).toStrictEqual(generated.backgrounds)
  })

  it('lists the ids in catalogue order and defaults to each first look', () => {
    expect([...LIVE_BACKGROUND_IDS]).toStrictEqual(generated.backgrounds.map((entry) => entry.id))
    for (const entry of generated.backgrounds) {
      expect(isLiveBackgroundId(entry.id)).toBe(true)
      expect(
        LIVE_BACKGROUND_DEFAULT_LOOKS[entry.id as keyof typeof LIVE_BACKGROUND_DEFAULT_LOOKS]
      ).toBe(entry.looks[0].id)
    }
  })

  it('parses every poster id back into its background and look', () => {
    const manifest = livePosterManifest()
    expect(manifest).toHaveLength(15)
    for (const poster of manifest) {
      const parsed = parseLivePosterAssetId(poster.id)
      expect(parsed).not.toBeNull()
      expect(livePosterAssetId(parsed!.id, parsed!.look)).toBe(poster.id)
      expect(poster.fileName).toBe(`${poster.id}.webp`)
    }
    expect(parseLivePosterAssetId('live-side-rays-moonlight')).toStrictEqual({
      id: 'side-rays',
      look: 'moonlight'
    })
    expect(parseLivePosterAssetId('builtin-bg-01')).toBeNull()
    expect(parseLivePosterAssetId('live-unknown-look')).toBeNull()
    expect(parseLivePosterAssetId('live-silk-')).toBeNull()
  })
})
