import { describe, expect, it } from 'vitest'

import { captionsOutputSwitches, overlayLayoutForDisplay } from './captions-output'
import { DEFAULT_OVERLAY_LAYOUT } from './overlay-layout'

// One switch (owner, 2026-11-20): Live captions in the Captions tab decides
// whether captions show, in every scene; a scene only places the bar.
describe('captions show by Live captions alone', () => {
  it('maps the switch and its one choice onto the outputs', () => {
    expect(captionsOutputSwitches({ enabled: false, burnTarget: 'stream' })).toStrictEqual({
      showOnStream: false,
      showInRecording: false
    })
    expect(captionsOutputSwitches({ enabled: false, burnTarget: 'both' })).toStrictEqual({
      showOnStream: false,
      showInRecording: false
    })
    expect(captionsOutputSwitches({ enabled: true, burnTarget: 'stream' })).toStrictEqual({
      showOnStream: true,
      showInRecording: false
    })
    expect(captionsOutputSwitches({ enabled: true, burnTarget: 'both' })).toStrictEqual({
      showOnStream: true,
      showInRecording: true
    })
  })

  it('ignores a scene saved with captions hidden once Live captions is on', () => {
    const hidden = {
      ...DEFAULT_OVERLAY_LAYOUT,
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: false, showInRecording: false }
    }
    const shown = overlayLayoutForDisplay(hidden, { enabled: true, burnTarget: 'stream' })
    expect(shown.captions).toMatchObject({ showOnStream: true, showInRecording: false })
    // Placement survives; every other item is untouched.
    expect(shown.captions.horizontal).toStrictEqual(hidden.captions.horizontal)
    expect(shown.highlight).toBe(hidden.highlight)
  })

  it('ignores a scene saved with captions on once Live captions is off', () => {
    const on = {
      ...DEFAULT_OVERLAY_LAYOUT,
      captions: { ...DEFAULT_OVERLAY_LAYOUT.captions, showOnStream: true, showInRecording: true }
    }
    expect(
      overlayLayoutForDisplay(on, { enabled: false, burnTarget: 'both' }).captions
    ).toMatchObject({ showOnStream: false, showInRecording: false })
  })

  it('keeps the same layout object when nothing differs', () => {
    expect(
      overlayLayoutForDisplay(DEFAULT_OVERLAY_LAYOUT, { enabled: false, burnTarget: 'stream' })
    ).toBe(DEFAULT_OVERLAY_LAYOUT)
  })
})
