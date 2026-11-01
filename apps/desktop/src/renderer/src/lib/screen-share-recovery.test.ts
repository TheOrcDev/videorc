import { describe, expect, it } from 'vitest'

import type { PreviewScreenState } from '@/lib/backend'
import {
  SCREEN_SHARE_DIALOG_LOST_MESSAGE,
  screenShareLostStatus,
  screenShareNeedsAsking
} from '@/lib/screen-share-recovery'

describe('screenShareLostStatus', () => {
  const base = { selected: true, switching: false }

  it('says a Linux share dialog closed unexpectedly, and how to ask again', () => {
    expect(
      screenShareLostStatus({
        ...base,
        preview: { state: 'permission-needed', message: SCREEN_SHARE_DIALOG_LOST_MESSAGE }
      })
    ).toEqual({
      label: 'Not shared',
      tone: 'warn',
      hint: 'The share dialog closed unexpectedly. Select Refresh to choose your screen again.'
    })
  })

  it('leaves every other state to videoSourceStatus', () => {
    const lost = { state: 'permission-needed' as const, message: SCREEN_SHARE_DIALOG_LOST_MESSAGE }
    expect(screenShareLostStatus({ ...base, preview: { state: 'permission-needed' } })).toBeNull()
    expect(screenShareLostStatus({ ...base, switching: true, preview: lost })).toBeNull()
    expect(screenShareLostStatus({ ...base, selected: false, preview: lost })).toBeNull()
    expect(screenShareLostStatus(base)).toBeNull()
  })
})

describe('screenShareNeedsAsking', () => {
  it('has Refresh ask again only for a portal share that is not live or waiting', () => {
    const portal = (state: PreviewScreenState | undefined, selectedId = 'screen:portal:monitor') =>
      screenShareNeedsAsking({ selectedId, state })
    expect(portal('permission-needed')).toBe(true)
    expect(portal('source-missing')).toBe(true)
    expect(portal('failed')).toBe(true)
    expect(portal('permission-needed', 'window:portal:window')).toBe(true)
    expect(portal('live')).toBe(false)
    expect(portal('starting')).toBe(false)
    // macOS and Windows permission prompts are the OS's, never re-asked here.
    expect(portal('permission-needed', 'screen:screencapturekit:1')).toBe(false)
    expect(screenShareNeedsAsking({ selectedId: undefined, state: 'source-missing' })).toBe(false)
  })
})
