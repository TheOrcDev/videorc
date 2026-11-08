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
        'microphone permission did not become granted before the watcher timed out; it is re-checked on focus.'
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

  it('re-check restarts exactly once for a grant noticed after the polling window (plan 203 S2)', async () => {
    vi.useFakeTimers()
    try {
      let status: MediaAccessStatus = 'not-determined'
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const log = vi.fn()
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: () => status,
        intervalMs: 100,
        maxChecks: 2,
        log,
        restartBackend
      })

      watcher.watch('screen-recording', 'restart after screen grant')
      await vi.advanceTimersByTimeAsync(300)
      expect(restartBackend).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith(
        'warn',
        'screen-recording permission did not become granted before the watcher timed out; it is re-checked on focus.'
      )

      await expect(watcher.recheck()).resolves.toBe(false)
      status = 'granted'
      await expect(watcher.recheck()).resolves.toBe(true)
      expect(restartBackend).toHaveBeenCalledTimes(1)
      expect(restartBackend).toHaveBeenCalledWith('restart after screen grant')

      await expect(watcher.recheck()).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(300)
      expect(restartBackend).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-check never restarts for an already-granted pane, with no watch, or after stop()', async () => {
    vi.useFakeTimers()
    try {
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: () => 'granted',
        intervalMs: 100,
        maxChecks: 2,
        restartBackend
      })

      await expect(watcher.recheck()).resolves.toBe(false)
      watcher.watch('camera', 'restart after camera grant')
      await expect(watcher.recheck()).resolves.toBe(false)
      expect(restartBackend).not.toHaveBeenCalled()

      let status: MediaAccessStatus = 'denied'
      const stopped = createMediaPermissionGrantWatcher({
        getStatus: () => status,
        intervalMs: 100,
        maxChecks: 2,
        restartBackend
      })
      stopped.watch('microphone', 'restart after microphone grant')
      stopped.stop()
      status = 'granted'
      await expect(stopped.recheck()).resolves.toBe(false)
      expect(restartBackend).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a poll and a re-check for the same grant restart once between them', async () => {
    vi.useFakeTimers()
    try {
      let status: MediaAccessStatus = 'denied'
      const restartBackend = vi.fn<() => Promise<void>>(() => Promise.resolve())
      const watcher = createMediaPermissionGrantWatcher({
        getStatus: () => status,
        intervalMs: 100,
        maxChecks: 5,
        restartBackend
      })

      watcher.watch('screen-recording', 'restart after screen grant')
      await vi.advanceTimersByTimeAsync(150)
      status = 'granted'
      await expect(watcher.recheck()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(500)
      expect(restartBackend).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
