import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CaptionsStatus, CaptionsUpdate } from '@/lib/backend'
import { CAPTION_STYLE_IDS, captionStyleDefinition } from '@/lib/caption-overlay'

import { CaptionsReader, captionReaderAppearance } from './captions-reader'

const line: CaptionsUpdate = {
  sessionClientId: 'session-1',
  seq: 1,
  kind: 'final',
  text: 'Welcome back to the stream.',
  chunkSeconds: 3
}

const reader = (status: CaptionsStatus, lines: CaptionsUpdate[] = []): string =>
  renderToStaticMarkup(createElement(CaptionsReader, { lines, status }))

describe('CaptionsReader (plan 174 S3.7, D-25, J2-18)', () => {
  it('is the Captions reader window with one status dot', () => {
    const markup = reader({ state: 'idle' })
    expect(markup).toContain('Captions reader')
    expect(markup.match(/data-slot="status-dot"/g)).toHaveLength(1)
    expect(markup).toContain('>Off<')
  })

  it('says off, waiting or listening while there is nothing to read', () => {
    expect(reader({ state: 'idle' })).toContain('Live captions are off.')
    expect(reader({ state: 'ready' })).toContain('Captions show here when you record or go live.')
    expect(reader({ state: 'listening' })).toContain('Listening…')
    expect(reader({ state: 'listening' }, [line])).not.toContain('captions-reader-notice')
  })

  it('gives a failure its reason, over the captions already shown', () => {
    const markup = reader({ state: 'error', message: 'The caption service is down.' }, [line])
    expect(markup).toMatch(/data-testid="captions-reader-notice"[^>]*role="alert"/)
    expect(markup).toContain('The caption service is down.')
    expect(markup).toContain('Welcome back to the stream.')
    expect(markup).toContain('>Failed<')
  })
})

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
