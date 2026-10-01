import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { EncoderPreferenceField } from './encoder-preference-field'

const render = (state: Parameters<typeof EncoderPreferenceField>[0]['state']): string =>
  renderToStaticMarkup(createElement(EncoderPreferenceField, { state, onChange: () => {} }))

describe('EncoderPreferenceField (plan 090 C5)', () => {
  it('is absent until the backend answers and on PCs without Intel graphics', () => {
    expect(render(null)).toBe('')
    expect(render({ preference: 'auto', quickSyncAvailable: false, envOverride: false })).toBe('')
    // A saved choice does not surface the control where it cannot apply.
    expect(
      render({ preference: 'quick-sync', quickSyncAvailable: false, envOverride: false })
    ).toBe('')
  })

  it('offers the choice as a beta on a PC with Intel graphics', () => {
    const markup = render({ preference: 'auto', quickSyncAvailable: true, envOverride: false })
    expect(markup).toContain('Fallback video encoder')
    expect(markup).toContain('Beta')
    expect(markup).toContain('Used only when this PC')
    expect(markup).toContain('falls back to software if its own check fails')
    expect(markup).not.toContain('disabled=""')
  })

  it('locks the control when a tester override decides it', () => {
    const markup = render({
      preference: 'quick-sync',
      quickSyncAvailable: true,
      envOverride: true
    })
    expect(markup).toContain('VIDEORC_WINDOWS_H264_ENCODER')
    expect(markup).toContain('disabled=""')
  })
})
