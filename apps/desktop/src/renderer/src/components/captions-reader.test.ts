import { describe, expect, it } from 'vitest'

import { CAPTION_STYLE_IDS, captionStyleDefinition } from '@/lib/caption-overlay'

import { captionReaderAppearance, captionStatusDotTone } from './captions-reader'

describe('captionReaderAppearance', () => {
  it.each(CAPTION_STYLE_IDS)('projects the shared %s registry entry', (styleId) => {
    const definition = captionStyleDefinition(styleId)
    const appearance = captionReaderAppearance(styleId)

    expect(appearance.style).toMatchObject({
      backgroundColor: definition.plate === 'none' ? 'transparent' : definition.backgroundColor,
      borderRadius: `${definition.radiusFactor}em`,
      color: definition.textColor,
      fontWeight: definition.fontWeight,
      textAlign: definition.align
    })
    expect(appearance.className.includes('w-full')).toBe(definition.wide)
  })
})

describe('captionStatusDotTone', () => {
  it('glows only where the caption state means something (plan 050, D9)', () => {
    expect(captionStatusDotTone('listening')).toBe('good')
    expect(captionStatusDotTone('live')).toBe('good')
    expect(captionStatusDotTone('reconnecting')).toBe('warn')
    expect(captionStatusDotTone('degraded')).toBe('warn')
    expect(captionStatusDotTone('blocked')).toBe('error')
    expect(captionStatusDotTone('error')).toBe('error')
    expect(captionStatusDotTone('idle')).toBe('neutral')
    expect(captionStatusDotTone('starting')).toBe('neutral')
  })
})
