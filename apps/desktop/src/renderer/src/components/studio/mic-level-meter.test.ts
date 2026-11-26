import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { MeterInput } from '@/lib/mic-meter-input'
import { MicLevelMeter } from './mic-level-meter'

it('draws an accessible segmented meter for sampled levels and live sources', () => {
  const inputs: MeterInput[] = [
    { kind: 'value', peakDb: -12 },
    { kind: 'source', source: createFrameEmitter<MeterFrame>() }
  ]
  for (const meter of inputs) {
    const markup = renderToStaticMarkup(
      createElement(MicLevelMeter, {
        meter,
        'aria-label': 'Microphone level',
        ...{ 'data-videorc-mic-visualizer': '' },
        className: 'min-w-0 flex-1'
      })
    )
    expect(markup.match(/role="meter"/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Microphone level"')
    expect(markup).toContain('data-videorc-mic-visualizer=""')
    expect(markup).toContain('data-variant="segmented"')
    expect(markup).not.toContain('data-slot="lcd-display"')
  }
})
