import { describe, expect, it } from 'vitest'

import { isSoundFileName, isSoundStarterSlug, soundAssetUrl } from './sound-assets'

describe('sound asset URLs (plan 189)', () => {
  it('addresses the managed sound host by encoded basename only', () => {
    const id = '0b7f3c2e-91d4-4a6b-8e25-6c1d9a0f4b37'
    expect(soundAssetUrl(`${id}.wav`)).toBe(`videorc-asset://sound/${id}.wav`)
    expect(soundAssetUrl(`/Users/me/Library/Sounds/${id}.wav`)).toBe(
      `videorc-asset://sound/${id}.wav`
    )
    expect(soundAssetUrl(`C:\\Users\\me\\Sounds\\${id}.wav`)).toBe(
      `videorc-asset://sound/${id}.wav`
    )
    expect(soundAssetUrl('a b#c.wav')).toBe('videorc-asset://sound/a%20b%23c.wav')
  })

  it('accepts bare .wav basenames and refuses paths, hops, hidden files and other types', () => {
    expect(isSoundFileName('0b7f3c2e.wav')).toBe(true)
    for (const bad of [
      '',
      '.wav',
      '../x.wav',
      'a/b.wav',
      'a\\b.wav',
      'a..wav',
      'x\0.wav',
      'x.mp3',
      7
    ]) {
      expect(isSoundFileName(bad)).toBe(false)
    }
    expect(isSoundFileName(`${'a'.repeat(252)}.wav`)).toBe(false)
    expect(isSoundFileName(`${'a'.repeat(251)}.wav`)).toBe(true)
  })

  it('accepts kebab-case starter slugs only', () => {
    for (const slug of ['airhorn', 'sad-trombone', 'tada2']) {
      expect(isSoundStarterSlug(slug)).toBe(true)
    }
    for (const bad of ['', 'Airhorn', 'sad_trombone', '-x', 'x-', 'a--b', 'a'.repeat(33), 3]) {
      expect(isSoundStarterSlug(bad)).toBe(false)
    }
  })
})
