import { describe, expect, it } from 'vitest'

import { avatarPlacementView } from './avatar-tab-view'

describe('avatarPlacementView (plan 239)', () => {
  it('says where viewers see the avatar, from its two switches', () => {
    expect(avatarPlacementView({ showOnStream: true, showInRecording: true })).toEqual({
      kind: 'both',
      label: 'On stream and in recordings',
      tone: 'tone-success'
    })
    expect(avatarPlacementView({ showOnStream: true, showInRecording: false })).toEqual({
      kind: 'stream',
      label: 'On stream, not in recordings',
      tone: 'tone-success'
    })
    expect(avatarPlacementView({ showOnStream: false, showInRecording: true })).toEqual({
      kind: 'recording',
      label: 'In recordings, not on stream',
      tone: 'tone-neutral'
    })
    expect(avatarPlacementView({ showOnStream: false, showInRecording: false })).toEqual({
      kind: 'off',
      label: 'Not on stream or in recordings',
      tone: 'tone-neutral'
    })
  })
})
