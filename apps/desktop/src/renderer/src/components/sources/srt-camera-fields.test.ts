import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { SrtInputControls } from '@/hooks/use-srt-input'
import type { SrtInputState } from '@/lib/backend'

import { SrtCameraFieldsView } from './srt-camera-fields'

const state = (patch: Partial<SrtInputState> = {}): SrtInputState => ({
  supported: true,
  enabled: true,
  port: 9000,
  connection: 'wifi',
  latencyMs: 120,
  passphrase: 'Abcdefghijklmnopqrstuvwxyz012345',
  cameraId: 'camera:srt-input',
  cameraName: 'SRT Camera (port 9000)',
  status: {
    listening: true,
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
    createElement(SrtCameraFieldsView, { controls, onCameraListChanged: () => {} })
  )
}

describe('SRT Camera fields on the Camera row (plan 250, option B)', () => {
  it('are absent until the backend answers, off macOS and while the input is off', () => {
    expect(render(null)).toBe('')
    expect(render(state({ supported: false }))).toBe('')
    expect(render(state({ enabled: false }))).toBe('')
  })

  it('show the port, the passphrase with Copy and New passphrase, the Connection and the lip-sync note', () => {
    const markup = render(state({ connection: 'cable', port: 9100 }))
    expect(markup).toContain('value="9100"')
    expect(markup).toContain('Abcdefghijklmnopqrstuvwxyz012345')
    expect(markup).toContain('Copy')
    expect(markup).toContain('New passphrase')
    expect(markup).toContain('Connection')
    expect(markup).toContain(
      'This camera arrives late. Set the microphone sync offset in the audio mixer to match.'
    )
  })

  it('puts the passphrase and its buttons on their own wrapping line under the label', () => {
    const markup = render(state())
    const tag = markup.match(/<div[^>]*data-testid="srt-input-passphrase-field"[^>]*>/)?.[0]
    expect(tag).toContain('data-orientation="vertical"')
    const field = markup.slice(markup.indexOf('data-testid="srt-input-passphrase-field"'))
    const label = field.indexOf('>Passphrase<')
    const value = field.indexOf('data-testid="srt-input-passphrase"')
    expect(label).toBeGreaterThan(-1)
    expect(value).toBeGreaterThan(label)
    expect(field.slice(label, value)).toContain('flex-wrap')
  })

  it('lock while Videorc is reconnecting', () => {
    const markup = render(state(), false)
    expect(markup).toMatch(
      /data-testid="srt-input-port"[^>]*disabled=""|disabled=""[^>]*data-testid="srt-input-port"/
    )
  })
})
