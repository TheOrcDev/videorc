import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  buddyLibraryPosePath,
  buddyLibraryPoseUrl,
  buddyOfficialPackFolder,
  buddyOfficialPackSlug,
  isBuddyPackId,
  parseBuddyAssetPath,
  parseBuddyDraftPath,
  parseBuddyLibraryPosePath,
  parseBuddyLibraryPoseUrl,
  parseBuddyPackPath
} from './buddy-assets'
import {
  BUDDY_DEFAULT_OFFICIAL_ID,
  BUDDY_LIBRARY_LIMIT,
  BUDDY_OFFICIAL_CATALOG,
  BUDDY_OFFICIAL_CATALOG_VERSION,
  BUDDY_OFFICIAL_SLUGS,
  isBuddyLibraryId,
  isBuddyUserAvatarId,
  isOfficialBuddyId,
  officialAliveFallback,
  officialAlivePackVersion,
  officialBuddy,
  officialBuddyId,
  officialSlugFromId,
  type BuddyOfficialAlive
} from './buddy-library'

const catalogFixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/buddy-official-catalog.json', import.meta.url),
    'utf8'
  )
) as { version: number; avatars: unknown[] }

const AVATAR = '7c9e6679-7425-40de-944b-e07fc1ee9a51'

describe('the official Buddy catalog (plan 170 D10, D11)', () => {
  it('equals protocol-fixtures/buddy-official-catalog.json, field for field', () => {
    expect(BUDDY_OFFICIAL_CATALOG_VERSION).toBe(catalogFixture.version)
    expect(BUDDY_OFFICIAL_CATALOG).toStrictEqual(catalogFixture.avatars)
  })

  it('lists every slug once, in order, with its own id', () => {
    expect(BUDDY_OFFICIAL_CATALOG.map((entry) => entry.slug)).toStrictEqual([
      ...BUDDY_OFFICIAL_SLUGS
    ])
    for (const entry of BUDDY_OFFICIAL_CATALOG) {
      expect(entry.id).toBe(officialBuddyId(entry.slug))
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.name.length).toBeLessThanOrEqual(24)
      expect(entry.personality.length).toBeLessThanOrEqual(1200)
    }
    // Buddy the Golem is the owner's original art; the others were described.
    expect(officialBuddy('golem')?.description).toBeNull()
    expect(officialBuddy('official:orc')?.name).toBe('Golmar')
    expect(officialBuddy('official:dragon')).toBeNull()
    expect(BUDDY_DEFAULT_OFFICIAL_ID).toBe('official:golem')
    expect(BUDDY_LIBRARY_LIMIT).toBe(30)
  })
})

describe('official alive packs (plan 172 D4)', () => {
  const filled: BuddyOfficialAlive = {
    version: 1,
    packId: 'official:orc',
    bundled: false,
    cellSize: 640,
    frames: 40,
    files: [
      { name: 'manifest.json', bytes: 1234, sha256: 'a'.repeat(64) },
      { name: 'mascot.webp', bytes: 3456789, sha256: 'b'.repeat(64) },
      { name: 'buddy.json', bytes: 123, sha256: 'c'.repeat(64) }
    ]
  }

  it('reads the catalog: alive right after description, a pack per row or null', () => {
    for (const row of catalogFixture.avatars as Record<string, unknown>[]) {
      const keys = Object.keys(row)
      expect(keys.indexOf('alive')).toBe(keys.indexOf('description') + 1)
      expect(keys.at(-1)).toBe('alive')
    }
    for (const entry of BUDDY_OFFICIAL_CATALOG) {
      if (!entry.alive) {
        expect(officialAlivePackVersion(entry.slug)).toBeNull()
        expect(officialAliveFallback(entry)).toBe('none')
        continue
      }
      expect(entry.alive.files.map((file) => file.name).sort()).toStrictEqual([
        'buddy.json',
        'manifest.json',
        'mascot.webp'
      ])
      // Only Buddy's own pack ships inside the app (bundled:buddy).
      expect(entry.alive.bundled).toBe(entry.slug === 'golem')
      expect(entry.alive.packId).toBe(
        entry.alive.bundled ? 'bundled:buddy' : `official:${entry.slug}`
      )
    }
  })

  it('tells bundled, downloadable and missing packs apart', () => {
    expect(officialAliveFallback({ alive: filled })).toBe('available')
    expect(officialAliveFallback({ alive: { ...filled, bundled: true } })).toBe('bundled')
    expect(officialAliveFallback({ alive: null })).toBe('none')
    expect(officialAlivePackVersion('dragon')).toBeNull()
  })

  it('takes official pack ids apart and resolves only listed packs', () => {
    expect(buddyOfficialPackSlug('official:orc')).toBe('orc')
    expect(buddyOfficialPackSlug('official:dragon')).toBe('dragon')
    for (const bad of ['official:', 'official:Orc', 'official:../orc', 'bundled:orc', 7]) {
      expect(buddyOfficialPackSlug(bad)).toBeNull()
    }
    expect(isBuddyPackId('official:orc')).toBe(true)
    expect(isBuddyPackId('official:../orc')).toBe(false)
    for (const entry of BUDDY_OFFICIAL_CATALOG) {
      const version = officialAlivePackVersion(entry.slug)
      expect(buddyOfficialPackFolder(`official:${entry.slug}`)).toBe(
        version === null ? null : `official/${entry.slug}/${version}`
      )
    }
    expect(buddyOfficialPackFolder('official:dragon')).toBeNull()
    expect(parseBuddyPackPath('default/pets/official:orc/manifest.json')).toBeNull()
  })
})

describe('library ids', () => {
  it('tells user avatars, known official ids and anything else apart', () => {
    expect(officialSlugFromId('official:pirate')).toBe('pirate')
    for (const bad of ['official:dragon', 'official:', 'Official:golem', 'golem', AVATAR, 7]) {
      expect(officialSlugFromId(bad)).toBeNull()
      expect(isOfficialBuddyId(bad)).toBe(false)
    }
    expect(isBuddyUserAvatarId(AVATAR)).toBe(true)
    for (const bad of [AVATAR.toUpperCase(), `${AVATAR}x`, 'official:golem', '', null]) {
      expect(isBuddyUserAvatarId(bad)).toBe(false)
    }
    expect(isBuddyLibraryId(AVATAR)).toBe(true)
    expect(isBuddyLibraryId('official:robot')).toBe(true)
    expect(isBuddyLibraryId('official:dragon')).toBe(false)
    expect(isBuddyLibraryId('../official:golem')).toBe(false)
  })
})

describe('library picture cache paths (plan 170 D12)', () => {
  it('builds and takes apart library/<avatarId>/<state>-<tag>.png', () => {
    const path = buddyLibraryPosePath(AVATAR, 'talk', '0a1b2c3d')
    expect(path).toBe(`library/${AVATAR}/talk-0a1b2c3d.png`)
    expect(parseBuddyLibraryPosePath(path)).toStrictEqual({
      avatarId: AVATAR,
      state: 'talk',
      tag: '0a1b2c3d',
      file: 'talk-0a1b2c3d.png'
    })
    const url = buddyLibraryPoseUrl(AVATAR, 'idle', 'ffffffff')
    expect(url).toBe(`videorc-asset://buddy/library/${AVATAR}/idle-ffffffff.png`)
    expect(parseBuddyLibraryPoseUrl(url)?.state).toBe('idle')
    // Never a persona image, a draft or a pack path, and the reverse.
    expect(parseBuddyAssetPath(path)).toBeNull()
    expect(parseBuddyDraftPath(path)).toBeNull()
    expect(parseBuddyPackPath(path)).toBeNull()
    expect(parseBuddyLibraryPosePath('default/idle-0a1b2c3d.png')).toBeNull()
  })

  it('refuses anything outside the cache', () => {
    for (const bad of [
      `library/${AVATAR}/idle.png`,
      `library/${AVATAR}/idle-0A1B2C3D.png`,
      `library/${AVATAR}/idle-0a1b2c3d.webp`,
      `library/${AVATAR}/../idle-0a1b2c3d.png`,
      `library/${AVATAR.toUpperCase()}/idle-0a1b2c3d.png`,
      `library/official:golem/idle-0a1b2c3d.png`,
      `/library/${AVATAR}/idle-0a1b2c3d.png`,
      `library/${AVATAR}/sleep-0a1b2c3d.png`,
      42
    ]) {
      expect(parseBuddyLibraryPosePath(bad)).toBeNull()
    }
    for (const bad of [
      `library/${AVATAR}/idle-0a1b2c3d.png`,
      `videorc-asset://avatar/library/${AVATAR}/idle-0a1b2c3d.png`,
      `file:///library/${AVATAR}/idle-0a1b2c3d.png`
    ]) {
      expect(parseBuddyLibraryPoseUrl(bad)).toBeNull()
    }
  })
})
