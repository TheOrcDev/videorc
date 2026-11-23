// @vitest-environment happy-dom
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CameraBackgroundArtKind } from './camera-background-art'
import { CameraBackgroundOrcArt } from './camera-background-orc-art'

function render(art: CameraBackgroundArtKind): Document {
  const markup = renderToStaticMarkup(createElement(CameraBackgroundOrcArt, { art }))
  return new DOMParser().parseFromString(markup, 'image/svg+xml')
}

function images(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName('image'))
}

describe('CameraBackgroundOrcArt', () => {
  it('draws the one Orc on top of every pick, never filtered', () => {
    const arts: CameraBackgroundArtKind[] = [
      { kind: 'room' },
      { kind: 'blur', strength: 'slight' },
      { kind: 'blur', strength: 'strong' },
      { kind: 'picture', src: '/assets/code-demo.webp' },
      { kind: 'screen', color: 'green' },
      { kind: 'screen', color: 'blue' }
    ]
    const orcs = arts.map((art) => {
      const top = images(render(art)).at(-1)
      expect(top?.getAttribute('filter')).toBeNull()
      return top?.getAttribute('href')
    })
    expect(new Set(orcs).size).toBe(1)
    expect(orcs[0]).toMatch(/orc\.webp/)
  })

  it('blurs the room layer only, more for Strong than for Slight', () => {
    const deviation = (strength: 'slight' | 'strong'): number => {
      const doc = render({ kind: 'blur', strength })
      const [room, orc] = images(doc)
      expect(room?.getAttribute('href')).toMatch(/orc-room\.webp/)
      expect(room?.getAttribute('filter')).toMatch(/^url\(#[\w-]+\)$/)
      expect(orc?.getAttribute('filter')).toBeNull()
      return Number(doc.getElementsByTagName('feGaussianBlur')[0]?.getAttribute('stdDeviation'))
    }
    expect(deviation('strong')).toBeGreaterThan(deviation('slight'))
    const off = render({ kind: 'room' })
    expect(off.getElementsByTagName('filter')).toHaveLength(0)
    expect(images(off)[0]?.getAttribute('href')).toMatch(/orc-room\.webp/)
  })

  it('puts the real picture or the flat screen colour behind the Orc', () => {
    const picture = render({ kind: 'picture', src: '/assets/product-launch.webp' })
    expect(images(picture)[0]?.getAttribute('href')).toBe('/assets/product-launch.webp')
    const green = render({ kind: 'screen', color: 'green' })
    expect(green.getElementsByTagName('rect')[0]?.getAttribute('fill')).toBe('#1fae4b')
    expect(images(green)).toHaveLength(1)
  })
})
