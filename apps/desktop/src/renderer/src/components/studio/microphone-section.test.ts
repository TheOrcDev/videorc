import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import type { Device } from '@/lib/backend'
import { micMeterInput, MicrophoneSectionView, type MeterInput } from './microphone-section'

const noop = (): void => {}
const microphones: Device[] = [
  { id: 'mic-1', name: 'Studio Mic', kind: 'microphone', status: 'available' },
  { id: 'mic-2', name: 'MacBook Pro Microphone', kind: 'microphone', status: 'available' }
]

function render(
  meter: MeterInput,
  overrides: Partial<Parameters<typeof MicrophoneSectionView>[0]> = {}
): string {
  return renderToStaticMarkup(
    createElement(MicrophoneSectionView, {
      devices: microphones,
      value: 'mic-1',
      selectedName: 'Studio Mic',
      disabled: false,
      discoveryPending: false,
      meter,
      monitorLabel: 'Live',
      onChange: noop,
      ...overrides
    })
  )
}

describe('micMeterInput (plan 092)', () => {
  const analyser = createFrameEmitter<MeterFrame>()
  const backend = createFrameEmitter<MeterFrame>()
  const base = {
    microphoneSelected: true,
    muted: false,
    backendSource: null,
    analyserDriven: false,
    source: analyser,
    backendPeakDb: null
  }

  it('prefers the backend levels, session or standby, then the analyser, then the 1 Hz level', () => {
    expect(micMeterInput({ ...base, backendSource: backend, analyserDriven: true })).toEqual({
      kind: 'source',
      source: backend
    })
    expect(micMeterInput({ ...base, analyserDriven: true, backendPeakDb: -20 })).toEqual({
      kind: 'source',
      source: analyser
    })
    expect(micMeterInput({ ...base, backendPeakDb: -20 })).toEqual({
      kind: 'value',
      peakDb: -20
    })
  })

  it('reads silence while muted, and nothing without a microphone or a reading', () => {
    expect(micMeterInput({ ...base, muted: true, backendSource: backend })).toEqual({
      kind: 'value',
      peakDb: Number.NEGATIVE_INFINITY
    })
    expect(micMeterInput({ ...base, microphoneSelected: false, backendSource: backend }).kind).toBe(
      'value'
    )
    expect(Number.isNaN((micMeterInput(base) as { peakDb: number }).peakDb)).toBe(true)
  })
})

describe('Microphone section (plan 092)', () => {
  it('holds the picker and the level, nothing more', () => {
    const markup = render({ kind: 'value', peakDb: -12 })
    expect(markup).toContain('>Microphone</h3>')
    // The picker keeps its label for screen readers under the section title.
    expect(markup).toMatch(/<label[^>]*class="[^"]*sr-only[^"]*"[^>]*>Microphone<\/label>/)
    // Radix fills the trigger's value on the client; the trigger itself is here.
    expect(markup).toContain('role="combobox"')
    expect(markup).toMatch(
      /role="meter"[^>]*data-videorc-mic-visualizer=""|data-videorc-mic-visualizer=""[^>]*role="meter"/
    )
    for (const gone of ['Check level', 'Mute microphone', 'System audio', 'Mix', 'Idle']) {
      expect(markup).not.toContain(gone)
    }
  })

  it('spans the picker with the meter alone: no readout beside it', () => {
    for (const meter of [
      { kind: 'value', peakDb: -12 } as const,
      { kind: 'source', source: createFrameEmitter<MeterFrame>() } as const
    ]) {
      const markup = render(meter)
      expect(markup).not.toContain('data-slot="db-readout"')
      expect(markup).not.toContain(' dB<')
      // The meter takes the whole row, which is the picker's width.
      expect(markup).toMatch(/class="[^"]*\bflex-1\b[^"]*"[^>]*data-slot="level-meter"/)
    }
  })

  it('names the signal state for screen readers and the perf probe, off screen', () => {
    const markup = render(
      { kind: 'source', source: createFrameEmitter<MeterFrame>() },
      { monitorLabel: 'Live' }
    )
    expect(markup).toContain(
      '<span class="sr-only" data-videorc-mic-monitor-state="live">Live</span>'
    )
    expect(render({ kind: 'value', peakDb: -40 }, { monitorLabel: 'Muted' })).toContain(
      'data-videorc-mic-monitor-state="muted">Muted</span>'
    )
  })
})
