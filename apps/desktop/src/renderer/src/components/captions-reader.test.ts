import { describe, expect, it } from 'vitest'

import { CAPTION_STYLE_IDS, captionStyleDefinition } from '@/lib/caption-overlay'

import { captionReaderAppearance } from './captions-reader'

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
