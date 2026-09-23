import { describe, expect, it } from 'vitest'

import { CAPTION_STYLE_IDS, captionStyleDefinition } from '@/lib/caption-overlay'

import { captionReaderAppearance, captionStatusToneClass } from './captions-reader'

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

describe('captionStatusToneClass', () => {
  it('glows only where the caption state means something (plan 050, D9)', () => {
    expect(captionStatusToneClass('listening')).toBe('tone-success')
    expect(captionStatusToneClass('live')).toBe('tone-success')
    expect(captionStatusToneClass('reconnecting')).toBe('tone-warning')
    expect(captionStatusToneClass('degraded')).toBe('tone-warning')
    expect(captionStatusToneClass('blocked')).toBe('tone-destructive')
    expect(captionStatusToneClass('error')).toBe('tone-destructive')
    expect(captionStatusToneClass('idle')).toBe('tone-neutral')
    expect(captionStatusToneClass('starting')).toBe('tone-neutral')
  })
})
