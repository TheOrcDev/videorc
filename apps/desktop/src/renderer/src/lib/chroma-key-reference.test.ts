import { describe, expect, it } from 'vitest'
import vectors from '../../../shared/chroma-key-vectors.json'
import { chromaKeyReference, keySpec } from './chroma-key-reference'

describe('native and talk-show chroma key vectors', () => {
  it.each(vectors)('$name', (vector) => {
    const actual = chromaKeyReference(vector.rgb, vector.settings)
    expect(Math.abs(actual.alpha - vector.expected.alpha)).toBeLessThanOrEqual(1)
    actual.rgb.forEach((channel, i) =>
      expect(Math.abs(channel - vector.expected.rgb[i])).toBeLessThanOrEqual(1)
    )
  })
  it('resolves hide edges once in source space', () => {
    const settings = {
      ...vectors[0].settings,
      cameraMirror: true,
      cameraChromaKeyEdges: { leftPct: 10, rightPct: 20, topPct: 5, bottomPct: 30 }
    }
    expect(keySpec(settings).edges).toEqual([0.2, 0.05, 0.9, 0.75])
  })
})
