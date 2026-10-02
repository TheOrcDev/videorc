// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFrameEmitter } from '@/lib/audio/frame-source'
import type { MeterFrame } from '@/lib/audio/types'
import { MicrophoneStripView, type MeterInput } from './audio-mixer'

let root: Root
let container: HTMLDivElement
const noop = (): void => {}

async function render(meter: MeterInput, muted = false): Promise<void> {
  await act(async () =>
    root.render(
      createElement(MicrophoneStripView, {
        deviceName: 'Studio Mic',
        muted,
        monitorLabel: muted ? 'Muted' : 'Live',
        signalLive: !muted,
        meter,
        warmReady: false,
        checkLevel: null,
        notice: null,
        permissionLabel: 'Open settings',
        deviceDetail: undefined,
        onPermission: noop,
        onToggleMute: noop
      })
    )
  )
}

function readout(): HTMLElement | null {
  return container.querySelector('[data-slot="db-readout"]')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Microphone strip readout across mute (plan 092)', () => {
  it('reads silence once muted, never the last live level', async () => {
    const source = createFrameEmitter<MeterFrame>()
    await render({ kind: 'source', source })
    await act(async () => {
      source.emit({ channels: [{ peakDb: -18 }] })
      vi.advanceTimersByTime(260)
    })
    expect(readout()?.textContent).toBe('−18.0 dB')

    // Muting swaps the live source for a silent value in the same strip.
    await render({ kind: 'value', peakDb: Number.NEGATIVE_INFINITY }, true)
    expect(readout()?.textContent).toBe('−∞ dB')
    expect(readout()?.hasAttribute('data-silent')).toBe(true)

    // Unmuting at the same level shows it again.
    await render({ kind: 'source', source })
    await act(async () => {
      source.emit({ channels: [{ peakDb: -18 }] })
      vi.advanceTimersByTime(260)
    })
    expect(readout()?.textContent).toBe('−18.0 dB')
  })
})
