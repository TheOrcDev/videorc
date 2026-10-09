import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  golemLibraryPosePath,
  golemLibraryPoseUrl,
  parseGolemAssetPath,
  parseGolemDraftPath,
  parseGolemLibraryPosePath,
  parseGolemLibraryPoseUrl,
  parseGolemPackPath
} from './golem-assets'
import {
  GOLEM_DEFAULT_OFFICIAL_ID,
  GOLEM_LIBRARY_LIMIT,
  GOLEM_OFFICIAL_CATALOG,
  GOLEM_OFFICIAL_CATALOG_VERSION,
  GOLEM_OFFICIAL_SLUGS,
  isGolemLibraryId,
  isGolemUserAvatarId,
  isOfficialGolemId,
  officialGolem,
  officialGolemId,
  officialSlugFromId
} from './golem-library'

const catalogFixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/golem-official-catalog.json', import.meta.url),
    'utf8'
  )
) as { version: number; avatars: unknown[] }

const AVATAR = '7c9e6679-7425-40de-944b-e07fc1ee9a51'

describe('the official Golem catalog (plan 170 D10, D11)', () => {
  it('equals protocol-fixtures/golem-official-catalog.json, field for field', () => {
    expect(GOLEM_OFFICIAL_CATALOG_VERSION).toBe(catalogFixture.version)
    expect(GOLEM_OFFICIAL_CATALOG).toStrictEqual(catalogFixture.avatars)
  })

  it('lists every slug once, in order, with its own id', () => {
    expect(GOLEM_OFFICIAL_CATALOG.map((entry) => entry.slug)).toStrictEqual([
      ...GOLEM_OFFICIAL_SLUGS
    ])
    for (const entry of GOLEM_OFFICIAL_CATALOG) {
      expect(entry.id).toBe(officialGolemId(entry.slug))
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.name.length).toBeLessThanOrEqual(24)
      expect(entry.personality.length).toBeLessThanOrEqual(1200)
    }
    // The Golem is the owner's original art; the others were described.
    expect(officialGolem('golem')?.description).toBeNull()
    expect(officialGolem('official:orc')?.name).toBe('Golmar')
    expect(officialGolem('official:dragon')).toBeNull()
    expect(GOLEM_DEFAULT_OFFICIAL_ID).toBe('official:golem')
    expect(GOLEM_LIBRARY_LIMIT).toBe(30)
  })
})

describe('library ids', () => {
  it('tells user avatars, known official ids and anything else apart', () => {
    expect(officialSlugFromId('official:pirate')).toBe('pirate')
    for (const bad of ['official:dragon', 'official:', 'Official:golem', 'golem', AVATAR, 7]) {
      expect(officialSlugFromId(bad)).toBeNull()
      expect(isOfficialGolemId(bad)).toBe(false)
    }
    expect(isGolemUserAvatarId(AVATAR)).toBe(true)
    for (const bad of [AVATAR.toUpperCase(), `${AVATAR}x`, 'official:golem', '', null]) {
      expect(isGolemUserAvatarId(bad)).toBe(false)
    }
    expect(isGolemLibraryId(AVATAR)).toBe(true)
    expect(isGolemLibraryId('official:robot')).toBe(true)
    expect(isGolemLibraryId('official:dragon')).toBe(false)
    expect(isGolemLibraryId('../official:golem')).toBe(false)
  })
})

describe('library picture cache paths (plan 170 D12)', () => {
  it('builds and takes apart library/<avatarId>/<state>-<tag>.png', () => {
    const path = golemLibraryPosePath(AVATAR, 'talk', '0a1b2c3d')
    expect(path).toBe(`library/${AVATAR}/talk-0a1b2c3d.png`)
    expect(parseGolemLibraryPosePath(path)).toStrictEqual({
      avatarId: AVATAR,
      state: 'talk',
      tag: '0a1b2c3d',
      file: 'talk-0a1b2c3d.png'
    })
    const url = golemLibraryPoseUrl(AVATAR, 'idle', 'ffffffff')
    expect(url).toBe(`videorc-asset://golem/library/${AVATAR}/idle-ffffffff.png`)
    expect(parseGolemLibraryPoseUrl(url)?.state).toBe('idle')
    // Never a persona image, a draft or a pack path, and the reverse.
    expect(parseGolemAssetPath(path)).toBeNull()
    expect(parseGolemDraftPath(path)).toBeNull()
    expect(parseGolemPackPath(path)).toBeNull()
    expect(parseGolemLibraryPosePath('default/idle-0a1b2c3d.png')).toBeNull()
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
      expect(parseGolemLibraryPosePath(bad)).toBeNull()
    }
    for (const bad of [
      `library/${AVATAR}/idle-0a1b2c3d.png`,
      `videorc-asset://avatar/library/${AVATAR}/idle-0a1b2c3d.png`,
      `file:///library/${AVATAR}/idle-0a1b2c3d.png`
    ]) {
      expect(parseGolemLibraryPoseUrl(bad)).toBeNull()
    }
  })
})
