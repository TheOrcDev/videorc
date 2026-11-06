import { describe, expect, it } from 'vitest'

import { buddyPictureUrl } from './buddy-picture'

describe('buddyPictureUrl', () => {
  it("is the persona's own idle picture as a managed URL", () => {
    expect(buddyPictureUrl({ images: { idle: 'p1/idle-0a1b2c3d.png', talk: 'p1/talk.png' } })).toBe(
      'videorc-asset://buddy/p1/idle-0a1b2c3d.png'
    )
  })

  it('is null for the golem: no picture of its own, or settings not loaded', () => {
    expect(buddyPictureUrl({ images: {} })).toBeNull()
    expect(buddyPictureUrl({ images: { talk: 'p1/talk.png' } })).toBeNull()
    expect(buddyPictureUrl(null)).toBeNull()
    expect(buddyPictureUrl(undefined)).toBeNull()
  })

  it('never builds a URL outside the managed root', () => {
    expect(buddyPictureUrl({ images: { idle: '../secrets/idle.png' } })).toBeNull()
    expect(buddyPictureUrl({ images: { idle: '/etc/idle.png' } })).toBeNull()
  })
})
