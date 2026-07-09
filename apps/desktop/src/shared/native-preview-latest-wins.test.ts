import { describe, expect, it } from 'vitest'

import {
  accountCoalescedPreviewFrame,
  accountSkippedPreviewFrame
} from './native-preview-latest-wins'

describe('accountSkippedPreviewFrame', () => {
  it('counts stale compositor frames as preview drops', () => {
    expect(
      accountSkippedPreviewFrame(
        {
          framesRendered: 40,
          presentedFrameId: 38,
          droppedFrames: 2
        },
        41
      )
    ).toEqual({
      framesRendered: 41,
      droppedFrames: 3,
      compositorFrameLag: 3
    })
  })

  it('does not double-count frames already accounted by a newer status', () => {
    expect(
      accountSkippedPreviewFrame(
        {
          framesRendered: 44,
          presentedFrameId: 42,
          droppedFrames: 6
        },
        43
      )
    ).toEqual({
      framesRendered: 44,
      droppedFrames: 6,
      compositorFrameLag: 2
    })
  })

  it('ignores invalid frame ids while preserving current accounting', () => {
    expect(
      accountSkippedPreviewFrame(
        {
          framesRendered: 7,
          presentedFrameId: 5,
          droppedFrames: 1
        },
        Number.NaN
      )
    ).toEqual({
      framesRendered: 7,
      droppedFrames: 1,
      compositorFrameLag: 2
    })
  })
})

describe('accountCoalescedPreviewFrame', () => {
  it('tracks a superseded compositor handoff separately from failed native presents', () => {
    expect(
      accountCoalescedPreviewFrame(
        {
          framesRendered: 40,
          presentedFrameId: 38,
          droppedFrames: 2,
          nativePreviewMainCoalescedFrameCount: 5
        },
        41
      )
    ).toEqual({
      framesRendered: 41,
      droppedFrames: 2,
      compositorFrameLag: 3,
      nativePreviewMainCoalescedFrameCount: 6
    })
  })
})
