import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  buddyLibraryPosePath,
  buddyLibraryPoseUrl,
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
  officialBuddy,
  officialBuddyId,
  officialSlugFromId
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
