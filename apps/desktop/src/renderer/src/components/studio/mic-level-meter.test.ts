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

  it('lights amber from −20 dB and red from −9, where the old segmented meter did', () => {
    const markup = render({ kind: 'value', peakDb: -12 })
    const fill = /--mic-meter-zones:([^;"]+)/.exec(markup)?.[1] ?? ''
    const stops = fill.match(/var\(--[a-z-]+\) [\d.]+% [\d.]+%/g) ?? []
    expect(stops.map((stop) => stop.split(' ')[0])).toEqual([
      'var(--lcd-display-lit)',
      'var(--meter-warn)',
      'var(--meter-clip)'
    ])
    // Each zone starts where the one before it ends, from 0 to 100%.
    const bounds = stops.map((stop) => stop.split(' ').slice(1).map(parseFloat))
    expect(bounds[0]?.[0]).toBe(0)
    expect(bounds.at(-1)?.[1]).toBe(100)
    for (let index = 1; index < bounds.length; index += 1) {
      expect(bounds[index]?.[0]).toBe(bounds[index - 1]?.[1])
    }
    expect(markup).toMatch(
      /class="[^"]*bg-\(image:--mic-meter-zones\)[^"]*"[^>]*data-slot="lcd-meter-bar"/
    )
    expect(markup).toMatch(
      /class="[^"]*bg-\(image:--mic-meter-zones\)[^"]*"[^>]*data-slot="lcd-meter-hold"/
    )
    const clip = /<button[^>]*data-slot="lcd-meter-clip"[^>]*>/.exec(markup)?.[0] ?? ''
    expect(clip).toContain('data-clipping:bg-meter-clip')
  })

  it('prints the digits in the zone of the level', () => {
    for (const [peakDb, zone] of [
      [-30, 'ok'],
      [-12, 'warn'],
      [-3, 'clip']
    ] as const) {
      const value =
        /<span[^>]*data-slot="lcd-meter-value"[^>]*>/.exec(
          render({ kind: 'value', peakDb })
        )?.[0] ?? ''
      expect(value, String(peakDb)).toContain(`data-zone="${zone}"`)
      expect(value, String(peakDb)).toContain('data-[zone=warn]:text-meter-warn-foreground')
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
