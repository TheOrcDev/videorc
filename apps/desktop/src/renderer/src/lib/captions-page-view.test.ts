import { describe, expect, it } from 'vitest'

import type { CaptionsStatus } from './backend'
import {
  captionsAllowanceLabel,
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

  it('names the edge and the outputs', () => {
    expect(captionsPlacementSummary({ ...captions, showOnStream: true }, 'horizontal')).toBe(
      'Bottom, on stream'
    )
    expect(
      captionsPlacementSummary(
        {
          ...captions,
          showOnStream: true,
          showInRecording: true,
          horizontal: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 }
        },
        'horizontal'
      )
    ).toBe('Top, on stream and in the recording')
    expect(captionsPlacementSummary({ ...captions, showInRecording: true }, 'vertical')).toBe(
      'Bottom, in the recording'
    )
  })

  it('says Hidden when the bar shows nowhere', () => {
    expect(captionsPlacementSummary(captions, 'horizontal')).toBe('Hidden')
  })
})

describe('captionsAllowanceLabel (D-27)', () => {
  it('counts whole minutes this month, and nothing until it is known', () => {
    expect(captionsAllowanceLabel(3_570)).toBe('60 min left this month')
    expect(captionsAllowanceLabel(0)).toBe('0 min left this month')
    expect(captionsAllowanceLabel(undefined)).toBeNull()
  })
})
