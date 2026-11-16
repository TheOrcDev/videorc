import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { CloudStatus } from './backend'
import {
  CONTINUE_ON_PHONE,
  HAND_OFF_LABEL,
  cloudTakenOverTitle,
  handOffLabel,
  handOffQuestionBody,
  offersHandOff,
  onAirDeviceName
} from './cloud-handoff-view'

// Plan 243 C5: every line the hand-off says, as data.

describe('the hand-off copy (plan 243 C5)', () => {
  it('names the answer for an in-app stop, a quit and a window close', () => {
    expect(handOffLabel('button')).toBe(HAND_OFF_LABEL)
    expect(HAND_OFF_LABEL).toBe('Continue on another device')
    expect(handOffLabel('palette')).toBe('Continue on another device')
    expect(handOffLabel('quit')).toBe('Quit and keep it live')
    expect(handOffLabel('close-window')).toBe('Close and keep it live')
  })

  it('says what End and the hand-off each do, and the recording once', () => {
    expect(
      handOffQuestionBody({ origin: 'button', platforms: ['YouTube'], alsoRecords: true })
    ).toBe(
      'Viewers on YouTube are disconnected. With Continue on another device, viewers see Be right back until you continue on your phone or another computer. Your recording stops either way and is saved to the Library.'
    )
    expect(handOffQuestionBody({ origin: 'quit', platforms: [], alsoRecords: false })).toBe(
      'Your viewers are disconnected. With Quit and keep it live, viewers see Be right back until you continue on your phone or another computer.'
    )
  })

  it('names the device on air, or its kind when it sent no name', () => {
    const base = { source: 'camera', waiting: false, thisDevice: false, since: 'x' } as const
    expect(onAirDeviceName({ ...base, kind: 'phone', name: 'iPhone' })).toBe('iPhone')
    expect(onAirDeviceName({ ...base, kind: 'phone' })).toBe('a phone')
    expect(onAirDeviceName({ ...base, kind: 'browser' })).toBe('a browser')
    expect(onAirDeviceName({ ...base, kind: 'computer', source: 'feed' })).toBe('another computer')
    expect(onAirDeviceName(undefined)).toBe('another device')
    expect(
      renderToStaticMarkup(cloudTakenOverTitle({ ...base, kind: 'phone', name: 'iPhone' }))
    ).toBe('Your show continues on iPhone.')
    expect(renderToStaticMarkup(cloudTakenOverTitle(undefined))).toBe(
      'Your show continues on another device.'
    )
    expect(CONTINUE_ON_PHONE).toBe('On your phone, open videorc.com/live/continue.')
  })
})

// Plan 243 C5: the hand-off is offered only on a managed show (videorc.com
// runs it) that this computer is on air for; a node show, a test show, a
// show waiting or live from another device, and an old web never offer it.
describe('offersHandOff (plan 243)', () => {
  const onAir = {
    kind: 'computer',
    source: 'feed',
    waiting: false,
    thisDevice: true,
    since: '2026-11-16T20:01:02.000Z'
  } as const
  const managed: CloudStatus = {
    phase: 'live',
    entitled: true,
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
    show: { id: 'sh_1', nodeId: 'livekit', resumable: false, kind: 'solo' },
    connected: true,
    directFallbackAvailable: false,
    onAir
  }

  it('offers it on a managed solo or talk show this computer is on air for', () => {
    expect(offersHandOff(managed)).toBe(true)
    expect(
      offersHandOff({
        ...managed,
        show: { ...managed.show!, kind: 'talk' },
        onAir: { ...onAir, source: 'host' }
      })
    ).toBe(true)
  })

  it('never offers it anywhere else', () => {
    for (const status of [
      null,
      { ...managed, onAir: undefined },
      { ...managed, onAir: { ...onAir, thisDevice: false } },
      { ...managed, onAir: { ...onAir, waiting: true } },
      { ...managed, show: { ...managed.show!, nodeId: 'node-fra-1' } },
      { ...managed, show: { ...managed.show!, kind: 'test' as const } },
      { ...managed, show: undefined }
    ]) {
      expect(offersHandOff(status)).toBe(false)
    }
  })
})
