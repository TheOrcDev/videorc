import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CameraOffAvatar } from '@/components/studio/camera-off-avatar'
import { HOST, ada } from '@/lib/guests-room-fixtures'
import { planStage } from '@/lib/talk-show-layout'
import {
  HOST_CIRCLE_CLIP,
  cameraOffLook,
  cameraPicture,
  hostCircle,
  nameInitial,
  showsAway
} from './talk-show-tile'

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

describe('hostCircle (plan 247 D-2)', () => {
  const canvas = { width: 1920, height: 1080 }
  const tilesOf = (layout: 'solo' | 'side-by-side' | 'screen-people') =>
    planStage(canvas, {
      layout,
      people: layout === 'solo' ? [HOST] : [HOST, ada.guestId],
      screen: layout === 'screen-people' ? HOST : null,
      spotlight: null
    }).tiles

  it("is the program page's rule: the host's person tile with corners, when the stage says circle", () => {
    const [host, guest] = tilesOf('side-by-side')
    expect(hostCircle(host, HOST, 'circle')).toBe(true)
    expect(hostCircle(guest, HOST, 'circle')).toBe(false)
    expect(hostCircle(host, HOST, 'rounded')).toBe(false)
    expect(hostCircle(host, HOST, undefined)).toBe(false)
  })

  it('never in Solo, where the tile has no corners, and never on a screen', () => {
    const [solo] = tilesOf('solo')
    expect(solo.cornerRadius).toBe(0)
    expect(hostCircle(solo, HOST, 'circle')).toBe(false)
    const screen = tilesOf('screen-people').find((tile) => tile.kind === 'screen')
    expect(screen && hostCircle(screen, HOST, 'circle')).toBe(false)
  })

  it('clips to the circle inscribed in the tile, centred', () => {
    expect(HOST_CIRCLE_CLIP).toBe('circle(closest-side at 50% 50%)')
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
