import { describe, expect, it } from 'vitest'

import {
  STREAM_MANAGER_DEFAULT_SIZE,
  STREAM_MANAGER_LAYOUT_VERSION,
  migrateStreamManagerFrame
} from './stream-manager-frame'

describe('Stream Manager frame migration', () => {
  it('moves a never-resized Chat window to the new default once', () => {
    const legacy = { x: 40, y: 60, width: 420, height: 640 }
    expect(migrateStreamManagerFrame({ frame: legacy })).toEqual({
      frame: { x: 40, y: 60, ...STREAM_MANAGER_DEFAULT_SIZE },
      migrated: true
    })
    // Once migrated, a later 420 × 640 frame is the user's own choice.
    expect(
      migrateStreamManagerFrame({ frame: legacy, layoutVersion: STREAM_MANAGER_LAYOUT_VERSION })
    ).toEqual({ frame: legacy, migrated: false })
  })

  it('keeps any frame the user sized, and a missing frame', () => {
    const sized = { x: 0, y: 0, width: 520, height: 900 }
    expect(migrateStreamManagerFrame({ frame: sized })).toEqual({ frame: sized, migrated: false })
    expect(migrateStreamManagerFrame({})).toEqual({ frame: undefined, migrated: false })
  })
})
