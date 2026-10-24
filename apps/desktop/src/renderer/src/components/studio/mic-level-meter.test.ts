import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { MeterInput } from '@/lib/mic-meter-input'
import { MicLevelMeter } from './mic-level-meter'

// The smokes and the perf probe find the meter by this attribute.
const hook = { 'data-videorc-mic-visualizer': '' }

function render(meter: MeterInput): string {
  return renderToStaticMarkup(
    createElement(MicLevelMeter, {
      ...hook,
      'aria-label': 'Microphone level',
      className: 'min-w-0 flex-1',
      meter
    })
  )
}

const INPUTS: MeterInput[] = [
  { kind: 'value', peakDb: -12 },
  { kind: 'source', source: createFrameEmitter<MeterFrame>() }
]

describe('MicLevelMeter on the LCD (plan 196)', () => {
  it("draws one meter on an LCD screen in Videorc's ink, for a source and for a reading", () => {
    for (const meter of INPUTS) {
      const markup = render(meter)
      expect(markup.match(/role="meter"/g), meter.kind).toHaveLength(1)
      const screen = /<div[^>]*data-slot="lcd-display"[^>]*>/.exec(markup)?.[0] ?? ''
      // D1 and D3: the theme's --primary ink, following the theme, default size.
      expect(screen, meter.kind).toContain('data-variant="primary"')
      expect(screen, meter.kind).toContain('data-appearance="auto"')
      expect(screen, meter.kind).toContain('data-size="default"')
      // The caller's layout lands on the bezel, its names on the meter.
      expect(screen, meter.kind).toMatch(/class="[^"]*\bmin-w-0 flex-1"/)
      const meterTag = /<div[^>]*role="meter"[^>]*>/.exec(markup)?.[0] ?? ''
      expect(meterTag, meter.kind).toContain('data-slot="lcd-meter"')
      expect(meterTag, meter.kind).toContain('aria-label="Microphone level"')
      expect(meterTag, meter.kind).toContain('data-videorc-mic-visualizer=""')
    }
  })

  it('prints the screen: the level without a unit, the scale and the CLIP flag (D2)', () => {
    const markup = render({ kind: 'value', peakDb: Number.NEGATIVE_INFINITY })
    expect(markup).toMatch(/data-slot="lcd-meter-value"[^>]*>−∞</)
    expect(markup).not.toContain(' dB<')
    expect(markup).toContain('data-slot="lcd-meter-scale"')
    expect(markup).toContain('data-slot="lcd-meter-bracket"')
    expect(markup).toMatch(/data-slot="lcd-meter-clip"[^>]*>Clip</)
  })
})
