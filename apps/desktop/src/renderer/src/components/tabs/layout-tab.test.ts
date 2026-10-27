import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { overlayEditsBlockedReason } from '@/components/scene/overlay-stage'
import type { OverlayItem } from '@/lib/backend'
import { OVERLAY_ITEM_OFF_LINES, OverlayItemInspector, OverlayItemSection } from './layout-tab'

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
    // Once, and only once: the app's one offline wording, as a polite lock
    // line (plan 174 S1.5), not an assertive alert.
    expect(markup.split('These controls come back in a moment.')).toHaveLength(2)
    expect(markup).toContain('data-variant="locked"')
    expect(markup).toContain('role="status"')
    expect(switches(markup)).toHaveLength(2)
    for (const control of [...switches(markup), ...snaps(markup)]) {
      expect(control).toContain('disabled=""')
    }
    expect(snaps(markup).length).toBeGreaterThan(0)
  })

  it('keeps the controls on, with no notice, while connected', () => {
    const markup = render(overlayEditsBlockedReason('connected'))
    expect(markup).not.toContain('data-slot="alert"')
    for (const control of [...switches(markup), ...snaps(markup)]) {
      expect(control).not.toContain('disabled=""')
    }
  })
})

// Plan 205 S3 (D4): Buddy with both switches off is never drawn, even while
// selected, so its section says so above the two switches.
function renderSection(
  item: OverlayItem,
  layout: { showOnStream: boolean; showInRecording: boolean }
): string {
  return renderToStaticMarkup(
    createElement(OverlayItemSection, {
      blockedReason: null,
      item,
      layout,
      orientation: 'horizontal',
      onPatch: () => {},
      onSnap: () => {}
    })
  )
}

const OFF_LINE = "Off. Viewers don't see Buddy."

describe('the overlay section (plan 205 S3, D4)', () => {
  it('says an off Buddy goes nowhere, above its two switches', () => {
    const markup = renderSection('buddy', { showOnStream: false, showInRecording: false })
    expect(OVERLAY_ITEM_OFF_LINES.buddy).toBe(OFF_LINE)
    // React escapes the apostrophe in markup.
    const line = markup.match(/<span data-videorc-overlay-off-line="buddy">([^<]*)<\/span>/)
    expect(line?.[1].replace(/&#x27;/g, "'")).toBe(OFF_LINE)
    expect(markup.indexOf('data-videorc-overlay-off-line')).toBeLessThan(
      markup.indexOf('role="switch"')
    )
    expect(markup).toContain('<h2')
    expect(markup).not.toContain('text-subtle')
    expect(switches(markup)).toHaveLength(2)
    for (const control of switches(markup)) expect(control).toContain('aria-checked="false"')
  })

  it('says nothing while Buddy goes to either output, or for the other items', () => {
    // The owner's Buddy (stream only): drawn, and its chip says "Stream only".
    for (const layout of [
      { showOnStream: true, showInRecording: false },
      { showOnStream: false, showInRecording: true },
      { showOnStream: true, showInRecording: true }
    ]) {
      expect(renderSection('buddy', layout)).not.toContain('data-videorc-overlay-off-line')
    }
    for (const item of ['highlight', 'captions'] as const) {
      const markup = renderSection(item, { showOnStream: false, showInRecording: false })
      expect(markup).not.toContain('data-videorc-overlay-off-line')
      expect(markup).not.toContain('Viewers don&#x27;t see')
    }
  })
})
