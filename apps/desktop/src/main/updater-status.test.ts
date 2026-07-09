import { describe, expect, it } from 'vitest'

import {
  BACKGROUND_RECHECK_INTERVAL_MS,
  clampPercent,
  isMissingUpdateFeedError,
  shouldAutoDownload,
  shouldBackgroundRecheck,
  updateStatusFromEvent
} from './updater-status'

describe('isMissingUpdateFeedError', () => {
  it('treats an unpublished feed (no channel / 404 manifest) as benign', () => {
    // The exact shape electron-updater throws for a Windows client hitting a
    // macOS-only feed (the tester report).
    expect(
      isMissingUpdateFeedError(
        'Cannot find channel "latest.yml" update info: HttpError: 404 "method: GET url: https://www.videorc.com/api/updates/latest.yml"'
      )
    ).toBe(true)
    expect(isMissingUpdateFeedError('HttpError: 404 latest-mac.yml')).toBe(true)
    expect(isMissingUpdateFeedError('Cannot find channel')).toBe(true)
  })

  it('does not swallow real errors', () => {
    expect(isMissingUpdateFeedError('net::ERR_INTERNET_DISCONNECTED')).toBe(false)
    expect(isMissingUpdateFeedError('sha512 checksum mismatch')).toBe(false)
    // A 404 mid-download of a package is a real failure, not a missing manifest.
    expect(isMissingUpdateFeedError('HttpError: 404 Videorc-0.9.25-win-x64.exe')).toBe(false)
  })
})

describe('updater status mapping', () => {
  it('maps each lifecycle event to its matching status', () => {
    expect(updateStatusFromEvent({ type: 'checking' })).toEqual({ phase: 'checking' })
    expect(updateStatusFromEvent({ type: 'available', version: '1.2.3' })).toEqual({
      phase: 'available',
      version: '1.2.3'
    })
    expect(updateStatusFromEvent({ type: 'not-available', currentVersion: '1.0.0' })).toEqual({
      phase: 'not-available',
      currentVersion: '1.0.0'
    })
    expect(updateStatusFromEvent({ type: 'downloaded', version: '1.2.3' })).toEqual({
      phase: 'downloaded',
      version: '1.2.3'
    })
    expect(updateStatusFromEvent({ type: 'error', message: 'nope' })).toEqual({
      phase: 'error',
      message: 'nope'
    })
    expect(updateStatusFromEvent({ type: 'unsupported' })).toEqual({ phase: 'unsupported' })
  })

  it('clamps and rounds download progress into 0–100', () => {
    expect(updateStatusFromEvent({ type: 'progress', percent: 42.7 })).toEqual({
      phase: 'downloading',
      percent: 43
    })
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(150)).toBe(100)
    expect(clampPercent(Number.NaN)).toBe(0)
  })

  // Regression (0.9.12 era): the launch-time check was the ONLY check, so a
  // release shipped while the app was running never surfaced the sidebar chip —
  // the user had to relaunch or manually check in Settings. The background flow
  // must re-check periodically while the app stays open.
  it('re-checks periodically from settled states, never mid-flight or once staged', () => {
    expect(shouldBackgroundRecheck({ phase: 'idle' })).toBe(true)
    expect(shouldBackgroundRecheck({ phase: 'not-available', currentVersion: '1.0.0' })).toBe(true)
    expect(shouldBackgroundRecheck({ phase: 'error', message: 'offline' })).toBe(true)
    // 'available' with no download in flight means the background download
    // failed — a re-check retries it.
    expect(shouldBackgroundRecheck({ phase: 'available', version: '1.2.3' })).toBe(true)

    expect(shouldBackgroundRecheck({ phase: 'checking' })).toBe(false)
    expect(shouldBackgroundRecheck({ phase: 'downloading', percent: 40 })).toBe(false)
    expect(shouldBackgroundRecheck({ phase: 'downloaded', version: '1.2.3' })).toBe(false)
    expect(shouldBackgroundRecheck({ phase: 'unsupported' })).toBe(false)

    expect(BACKGROUND_RECHECK_INTERVAL_MS).toBe(30 * 60 * 1000)
  })

  it('auto-downloads only when an update is available', () => {
    expect(shouldAutoDownload({ phase: 'available', version: '1.2.3' })).toBe(true)
    expect(shouldAutoDownload({ phase: 'not-available', currentVersion: '1.0.0' })).toBe(false)
    expect(shouldAutoDownload({ phase: 'idle' })).toBe(false)
    expect(shouldAutoDownload({ phase: 'downloaded', version: '1.2.3' })).toBe(false)
  })
})
