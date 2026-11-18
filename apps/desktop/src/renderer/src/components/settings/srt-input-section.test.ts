import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SrtInputControls } from '@/hooks/use-srt-input'
import type { SrtInputState } from '@/lib/backend'

import { SrtInputSectionView } from './srt-input-section'

const state = (patch: Partial<SrtInputState> = {}): SrtInputState => ({
  supported: true,
  enabled: false,
  port: 9000,
  connection: 'wifi',
  latencyMs: 120,
  passphrase: 'Abcdefghijklmnopqrstuvwxyz012345',
  cameraId: 'camera:srt-input',
  cameraName: 'SRT Camera (port 9000)',
  status: {
    listening: false,
    senderConnected: false,
    senderSession: 0,
    framesDecoded: 0,
    signal: 'waiting',
    detail: 'Waiting'
  },
  ...patch
})

const render = (value: SrtInputState | null, connected = true): string => {
  const controls: SrtInputControls = {
    state: value,
    stateRef: { current: value },
    connected,
    set: async () => ({ ok: true }),
    renewPassphrase: async () => ({ ok: true })
  }
  return renderToStaticMarkup(
    createElement(SrtInputSectionView, { controls, onCameraListChanged: () => {} })
  )
}

describe('SrtInputSection (plan 250)', () => {
  it('is absent until the backend answers and off macOS (D9)', () => {
    expect(render(null)).toBe('')
    expect(render(state({ supported: false }))).toBe('')
  })

  it('is the opt-in alone: the title, the Beta badge, the description and the switch', () => {
    for (const enabled of [false, true]) {
      const markup = render(state({ enabled }))
      expect(markup).toContain('SRT input')
      expect(markup).toContain('Beta')
      expect(markup).toContain('Adds the SRT Camera to the camera list in Sources.')
      expect(markup).toContain('data-testid="srt-input-switch"')
      // Option B: the camera's own settings live on its row in Sources.
      expect(markup).not.toContain('Passphrase')
      expect(markup).not.toContain('srt-input-port')
      expect(markup).not.toContain('Connection')
      expect(markup).not.toContain('microphone sync offset')
    }
  })

  it('locks the switch while Videorc is reconnecting', () => {
    const markup = render(state({ enabled: true }), false)
    expect(markup).toMatch(
      /data-testid="srt-input-switch"[^>]*disabled=""|disabled=""[^>]*data-testid="srt-input-switch"/
    )
  })
})
