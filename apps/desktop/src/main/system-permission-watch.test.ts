import { describe, expect, it, vi } from 'vitest'

import {
  createMediaPermissionGrantWatcher,
  mediaAccessPermissionForPane,
  type MediaAccessPermissionName,
  type MediaAccessStatus
} from './system-permission-watch'

describe('mediaAccessPermissionForPane', () => {
  it('maps app permission panes to Electron media access names', () => {
    expect(mediaAccessPermissionForPane('camera')).toBe('camera')
    expect(mediaAccessPermissionForPane('microphone')).toBe('microphone')
    expect(mediaAccessPermissionForPane('screen-recording')).toBe('screen')
    expect(mediaAccessPermissionForPane('privacy')).toBeNull()
  })
})

describe('createMediaPermissionGrantWatcher', () => {
  it('does not restart when Settings opens for an already-granted permission', async () => {
    vi.useFakeTimers()
    try {
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: () => 'granted',
        intervalMs: 100,
        maxChecks: 2,
        restartBackend
      })

      watcher.watch('camera', 'restart after camera grant')
      await vi.advanceTimersByTimeAsync(300)

      expect(restartBackend).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts the backend when a permission changes to granted after Settings opens', async () => {
    vi.useFakeTimers()
    try {
      const statuses: MediaAccessStatus[] = ['denied', 'denied', 'granted']
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: vi.fn((_permission: MediaAccessPermissionName) => statuses.shift() ?? 'denied'),
        intervalMs: 100,
        maxChecks: 5,
        restartBackend
      })

      watcher.watch('camera', 'restart after camera grant')
      await vi.advanceTimersByTimeAsync(300)

      expect(restartBackend).toHaveBeenCalledTimes(1)
      expect(restartBackend).toHaveBeenCalledWith('restart after camera grant')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not restart when the permission never becomes granted', async () => {
    vi.useFakeTimers()
    try {
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const log = vi.fn()
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: () => 'denied',
        intervalMs: 100,
        maxChecks: 2,
        log,
        restartBackend
      })

      watcher.watch('microphone', 'restart after microphone grant')
      await vi.advanceTimersByTimeAsync(300)

      expect(restartBackend).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(
        'warn',
        'microphone permission did not become granted before the watcher timed out.'
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces an older watch when a newer permission pane opens', async () => {
    vi.useFakeTimers()
    try {
      const statusByPermission: Record<MediaAccessPermissionName, MediaAccessStatus> = {
        camera: 'granted',
        microphone: 'denied',
        screen: 'denied'
      }
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: (permission) => statusByPermission[permission],
        intervalMs: 100,
        maxChecks: 2,
        restartBackend
      })

      watcher.watch('camera', 'restart after camera grant')
      watcher.watch('microphone', 'restart after microphone grant')
      await vi.advanceTimersByTimeAsync(300)

      expect(restartBackend).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
