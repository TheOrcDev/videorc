import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { overlayEditsBlockedReason } from '@/components/scene/overlay-stage'
import { OverlayItemInspector } from './layout-tab'

// Plan 174, C-6: overlay changes never fail silently. Without the backend the
// controls are off, with one reason above them.

function render(blockedReason: string | null): string {
  return renderToStaticMarkup(
    createElement(OverlayItemInspector, {
      blockedReason,
      item: 'buddy',
      layout: { showOnStream: true, showInRecording: false },
      orientation: 'horizontal',
      onPatch: () => {},
      onSnap: () => {}
    })
  )
}

const switches = (markup: string): string[] =>
  markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? []
// The snaps are one-shot Buttons inside the "Snap overlay" group (plan 174 S1.7, C-37).
const snaps = (markup: string): string[] =>
  markup
    .split('aria-label="Snap overlay"')[1]
    ?.match(/<button[^>]*>/g)
    ?.filter((button) => !button.includes('role=')) ?? []

describe('the overlay inspector (plan 174, C-6)', () => {
  it('turns every control off with one reason while the backend is away', () => {
    const reason = overlayEditsBlockedReason('closed')!
    const markup = render(reason)
    // Once, and only once (the markup escapes the apostrophe in "can't").
    expect(markup.split('change until the backend is connected.')).toHaveLength(2)
    expect(markup).toContain('role="alert"')
    expect(switches(markup)).toHaveLength(2)
    for (const control of [...switches(markup), ...snaps(markup)]) {
      expect(control).toContain('disabled=""')
    }
    expect(snaps(markup).length).toBeGreaterThan(0)
  })

  it('keeps the controls on, with no notice, while connected', () => {
    const markup = render(overlayEditsBlockedReason('connected'))
    expect(markup).not.toContain('role="alert"')
    for (const control of [...switches(markup), ...snaps(markup)]) {
      expect(control).not.toContain('disabled=""')
    }
  })
})
