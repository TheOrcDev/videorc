import { describe, expect, it } from 'vitest'

import type { CaptionsStatus } from './backend'
import {
  CAPTIONS_OUTPUT_OPTIONS,
  captionsAllowanceLabel,
  captionsOutputsDescription,
  captionsPlacementSummary,
  captionsReaderNotice,
  captionsStatusDetail
} from './captions-page-view'
import { DEFAULT_OVERLAY_LAYOUT } from './overlay-layout'

const status = (state: CaptionsStatus['state'], extra: Partial<CaptionsStatus> = {}) =>
  ({ state, ...extra }) as CaptionsStatus

describe('captionsReaderNotice (plan 174 S3.7, D-25, J2-18)', () => {
  it('tells off from waiting by the backend intent', () => {
    expect(captionsReaderNotice(status('idle'), 0)?.text).toBe(
      'Live captions are off. Turn them on in Captions, then record or go live.'
    )
    expect(captionsReaderNotice(status('idle', { desiredEnabled: true }), 0)?.text).toBe(
      'Captions show here when you record or go live.'
    )
    expect(captionsReaderNotice(status('ready'), 0)?.text).toBe(
      'Captions show here when you record or go live.'
    )
    expect(captionsReaderNotice(status('starting'), 0)?.text).toBe('Starting captions…')
    expect(captionsReaderNotice(status('listening'), 0)?.text).toBe('Listening…')
  })

  it('shows a failure with its reason, even over earlier captions', () => {
    expect(
      captionsReaderNotice(status('error', { message: 'The caption service is down.' }), 4)
    ).toEqual({ text: 'The caption service is down.', failed: true })
    expect(captionsReaderNotice(status('blocked'), 0)).toEqual({
      text: 'Captions need attention before they can start. Open Captions.',
      failed: true
    })
  })

  it('stays out of the way while there are captions to read', () => {
    for (const state of [
      'idle',
      'ready',
      'starting',
      'listening',
      'live',
      'reconnecting'
    ] as const) {
      expect(captionsReaderNotice(status(state), 2), state).toBeNull()
    }
  })
})

describe('captionsStatusDetail', () => {
  it('says what the state means, with the backend reason when it has one', () => {
    expect(captionsStatusDetail(status('listening'), true)).toBe(
      'Your microphone is being transcribed.'
    )
    expect(captionsStatusDetail(status('ready'), false)).toBe(
      'Starts with your next recording or livestream.'
    )
    expect(captionsStatusDetail(status('error', { message: 'Quota used up.' }), true)).toBe(
      'Quota used up.'
    )
  })
})

describe('captionsPlacementSummary (D-27)', () => {
  const captions = DEFAULT_OVERLAY_LAYOUT.captions

  it('names the edge the scene puts the bar on', () => {
    expect(captionsPlacementSummary(captions, 'horizontal')).toBe('Bottom')
    expect(
      captionsPlacementSummary(
        { ...captions, horizontal: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 } },
        'horizontal'
      )
    ).toBe('Top')
    expect(captionsPlacementSummary(captions, 'vertical')).toBe('Bottom')
  })

  it('never says Hidden: the scene only places the bar (one switch, 2026-11-20)', () => {
    // The default captions item has both old switches off, which used to
    // read "Hidden" while Live captions was on.
    expect(captions.showOnStream || captions.showInRecording).toBe(false)
    expect(captionsPlacementSummary(captions, 'horizontal')).not.toBe('Hidden')
  })
})

describe('captionsOutputsDescription', () => {
  it('says what the recording gets, and what a vertical stream does to it', () => {
    expect(captionsOutputsDescription('stream', false)).toBe('Your recording stays clean.')
    expect(captionsOutputsDescription('both', false)).toBe(
      'Your recording also gets a copy with captions.'
    )
    expect(captionsOutputsDescription('stream', true)).toMatch(/in the recording too/)
  })

  it('offers the live stream always, the recording as the only choice', () => {
    expect(CAPTIONS_OUTPUT_OPTIONS.map((option) => option.label)).toEqual([
      'Live stream only',
      'Live stream and recording'
    ])
  })
})

describe('captionsAllowanceLabel (D-27)', () => {
  it('counts whole minutes this month, and nothing until it is known', () => {
    expect(captionsAllowanceLabel(3_570)).toBe('60 min left this month')
    expect(captionsAllowanceLabel(0)).toBe('0 min left this month')
    expect(captionsAllowanceLabel(undefined)).toBeNull()
  })
})

it('keeps the service outage visible above stale caption lines', () => {
  const message = 'Captions paused: Videorc AI is unavailable. They come back on their own.'
  const paused = {
    state: 'degraded' as const,
    desiredEnabled: true,
    providerReady: false,
    reasonCode: 'service-unavailable',
    message
  }
  expect(captionsStatusDetail(paused, true)).toBe(message)
  expect(captionsReaderNotice(paused, 3)).toEqual({ text: message, failed: true })
})
