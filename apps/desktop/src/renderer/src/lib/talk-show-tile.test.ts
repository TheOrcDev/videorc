import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CameraOffAvatar } from '@/components/studio/camera-off-avatar'
import { cameraOffLook, cameraPicture, nameInitial, showsAway } from './talk-show-tile'

// Wire contract 5.5 (decision 75): camera off is a muted camera publication,
// the tile stays with the camera-off look, and it is never away.

const track = {} as MediaStreamTrack

describe('cameraPicture', () => {
  it('shows the camera while it is on', () => {
    expect(cameraPicture(track, false)).toEqual({ track, cameraOff: false })
    expect(cameraPicture(track, undefined)).toEqual({ track, cameraOff: false })
  })

  it('shows no frame of a camera that is off, even while its track is still held', () => {
    expect(cameraPicture(track, true)).toEqual({ track: null, cameraOff: true })
  })

  it('tells no camera from a camera that is off', () => {
    expect(cameraPicture(null, false)).toEqual({ track: null, cameraOff: false })
    expect(cameraPicture(undefined, true)).toEqual({ track: null, cameraOff: true })
  })
})

describe('showsAway', () => {
  it('never draws Back in a moment over someone whose camera is off', () => {
    expect(showsAway(true, false)).toBe(true)
    expect(showsAway(true, true)).toBe(false)
    expect(showsAway(false, false)).toBe(false)
    expect(showsAway(undefined, true)).toBe(false)
  })
})

describe('nameInitial', () => {
  it('is the first character of the name, in capitals', () => {
    expect(nameInitial('ana maría')).toBe('A')
    expect(nameInitial('  bo ')).toBe('B')
    expect(nameInitial('éric')).toBe('É')
    expect(nameInitial('')).toBe('?')
  })
})

describe('cameraOffLook', () => {
  it('is the program page’s: a circle 36 % of the short side, the letter half of it', () => {
    expect(cameraOffLook(944, 531)).toEqual({ diameter: 191, fontPx: 96 })
    expect(cameraOffLook(20, 10).fontPx).toBe(8)
  })
})

describe('CameraOffAvatar', () => {
  it('draws the letter for sight and the words for screen readers', () => {
    const markup = renderToStaticMarkup(
      createElement(CameraOffAvatar, { name: 'bo', circle: '10cqw', letter: '5cqw' })
    )
    expect(markup).toContain('data-slot="camera-off-avatar"')
    expect(markup).toMatch(/aria-hidden="true"[^>]*>B</)
    expect(markup).toContain('<span class="sr-only">Camera off</span>')
    expect(markup).toContain('width:10cqw')
    expect(markup).toContain('font-size:5cqw')
  })
})
