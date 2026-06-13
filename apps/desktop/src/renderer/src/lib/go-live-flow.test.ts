import { describe, expect, it } from 'vitest'

import { defaultStreamingSettings } from './capture'
import {
  decideCancelGoLiveConfirmation,
  decideContinueGoLiveWithReadyDestinations,
  decideGoLivePreflight,
  decideGoLiveStart,
  decidePreparedGoLiveSetup,
  type GoLivePartialSetup
} from './go-live-flow'

const streaming = {
  ...defaultStreamingSettings(),
  enabled: true,
  enabledTargetIds: ['youtube']
}

const partialSetup: GoLivePartialSetup = {
  streaming,
  failures: [
    {
      targetId: 'twitch',
      platform: 'twitch',
      label: 'Twitch',
      message: 'Reconnect Twitch.'
    }
  ],
  readyLabels: ['YouTube']
}

describe('go live flow decisions', () => {
  it('starts non-stream sessions directly', () => {
    expect(decideGoLiveStart(false)).toBe('start-directly')
  })

  it('opens confirmation for stream sessions', () => {
    expect(decideGoLiveStart(true)).toBe('open-confirmation')
  })

  it('blocks start when preflight is invalid', () => {
    expect(decideGoLivePreflight({ valid: false })).toEqual({ kind: 'blocked' })
  })

  it('keeps confirmation open and stores ready streaming snapshot after partial setup', () => {
    expect(decidePreparedGoLiveSetup(partialSetup)).toEqual({
      kind: 'partial',
      setup: partialSetup
    })
  })

  it('continues with the ready destinations from partial setup', () => {
    expect(
      decideContinueGoLiveWithReadyDestinations({
        goLiveConfirmationPending: false,
        startRequestPending: false,
        partialSetup
      })
    ).toEqual({
      kind: 'start',
      streaming
    })
  })

  it('cleans up prepared platform broadcasts when canceling partial setup', () => {
    expect(
      decideCancelGoLiveConfirmation({
        goLiveConfirmationPending: false,
        startRequestPending: false,
        partialSetup
      })
    ).toEqual({
      kind: 'close',
      cleanupStreaming: streaming
    })
  })
})
