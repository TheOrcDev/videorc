import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { Scene, SceneSource, SceneTransform } from '@/lib/backend'

import { LookPicture } from './look-picture'

const transform = (x: number, y: number, width: number, height: number): SceneTransform => ({
  x,
  y,
  width,
  height,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
})

const source = (kind: 'camera' | 'screen', box: SceneTransform): SceneSource => ({
  id: kind,
  name: kind,
  kind,
  deviceId: kind,
  transform: box,
  defaultTransform: box,
  visible: true,
  locked: false
})

describe('LookPicture', () => {
  it('truncates a long device name inside its chip instead of clipping the chip', () => {
    // The Screen + camera inset is small: "MacBook Pro Camera" read
    // "lacBook Pro Cam" with its status dot cut off (E2E 2026-11-01).
    const scene: Scene = {
      id: 'scene',
      name: 'Scene',
      sources: [
        source('screen', transform(0, 0, 1, 1)),
        source('camera', transform(0.72, 0.68, 0.24, 0.27))
      ],
      outputs: []
    }
    const markup = renderToStaticMarkup(
      createElement(LookPicture, {
        scene,
        aspect: 16 / 9,
        cameraShape: 'rectangle',
        cameraCornerRadiusPct: 12,
        background: null,
        names: { camera: 'MacBook Pro Camera', screen: 'Display 1' }
      })
    )

    const chips = [
      ...markup.matchAll(/<span data-slot="badge"[^>]*class="([^"]*)"[^>]*>(.*?)<\/span><\/div>/g)
    ]
    expect(chips).toHaveLength(2)
    for (const [, chipClass, inner] of chips) {
      expect(chipClass.split(' ')).not.toContain('truncate')
      expect(inner).toMatch(/^<span class="truncate">[^<]+<\/span>$/)
    }
    expect(markup).toContain('<span class="truncate">MacBook Pro Camera</span>')
  })
})
