import { describe, expect, it } from 'vitest'

import {
  RECORDINGS_FOLDER_EXPIRED,
  RECORDINGS_FOLDER_NOT_WRITABLE,
  recordingsFolderView
} from './recordings-folder'

const DEFAULT_PATH = '~/Movies/Videorc/Recordings'

describe('recordingsFolderView (plan 174 S3.6, I-22/I-23)', () => {
  it('names the default folder by its path when none is chosen', () => {
    expect(
      recordingsFolderView({
        displayName: '',
        handle: undefined,
        facts: null,
        defaultPath: DEFAULT_PATH
      })
    ).toEqual({ path: DEFAULT_PATH, custom: false, detail: null, problem: null, canReveal: false })
  })

  it('goes by the grant, not the name: a name without one is the default folder', () => {
    const view = recordingsFolderView({
      displayName: 'Old typed path',
      handle: undefined,
      facts: null,
      defaultPath: DEFAULT_PATH
    })
    expect(view.path).toBe(DEFAULT_PATH)
    expect(view.custom).toBe(false)
  })

  it('shows a chosen folder with its free space once checked', () => {
    expect(
      recordingsFolderView({
        displayName: 'Recordings',
        handle: 'handle-1',
        facts: { exists: true, writable: true, freeBytes: 120 * 1024 ** 3 },
        defaultPath: DEFAULT_PATH
      })
    ).toEqual({
      path: 'Recordings',
      custom: true,
      detail: '120 GB free',
      problem: null,
      canReveal: true
    })
  })

  it('says why a chosen folder fails, and how to fix it', () => {
    const base = { displayName: 'Recordings', handle: 'handle-1', defaultPath: DEFAULT_PATH }
    const expired = recordingsFolderView({
      ...base,
      facts: { exists: false, writable: false, freeBytes: null }
    })
    expect(expired).toMatchObject({ problem: RECORDINGS_FOLDER_EXPIRED, canReveal: false })
    const readOnly = recordingsFolderView({
      ...base,
      facts: { exists: true, writable: false, freeBytes: 10 }
    })
    expect(readOnly).toMatchObject({ problem: RECORDINGS_FOLDER_NOT_WRITABLE, canReveal: true })
  })

  it('waits for the check before offering Show in Finder', () => {
    expect(
      recordingsFolderView({
        displayName: '',
        handle: 'handle-1',
        facts: null,
        defaultPath: DEFAULT_PATH
      })
    ).toMatchObject({ path: 'Chosen folder', custom: true, canReveal: false })
  })
})
