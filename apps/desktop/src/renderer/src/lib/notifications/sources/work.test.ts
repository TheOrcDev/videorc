import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  publishCleanCutAutoFailed,
  publishCleanCutReady,
  publishClipSaved,
  publishClipSaveFailed,
  publishClipsCouldNotStart,
  publishClipsStopped,
  publishCloudDownloadFailed,
  publishCloudDownloadSaved,
  publishMp4ExportFailed,
  publishMp4Finalizing,
  publishMp4Ready,
  resolveClips
} from '@/lib/notifications/sources/work'
import { createNotificationStore, type NotificationStore } from '@/lib/notifications/store'

describe('finished work as notifications (plan 250 S7)', () => {
  let store: NotificationStore
  let live = false
  const door = { show: vi.fn(), resolved: vi.fn(), dismiss: vi.fn() }
  const entry = (key: string) => store.snapshot().find((item) => item.key === key)

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    live = false
    store = createNotificationStore({ live: () => live })
    store.setPopUpDoor(door)
  })

  describe('an MP4 export is one entry: a spinner, then ready or failed', () => {
    it('runs with no toast, then "MP4 ready" keeps its reveal action and no leftover words', () => {
      publishMp4Finalizing('take-1', 'Saving MP4 · 12%', store)
      publishMp4Finalizing('take-1', 'Saving MP4 · 98%', store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('mp4:take-1')).toMatchObject({
        state: 'running',
        title: 'Saving MP4 · 98%',
        detail: 'Your recording is safe. Long recordings can take several minutes to save as MP4.',
        actions: []
      })
      // Nothing is pinned for the length of an export, and it is not counted.
      expect(door.show).not.toHaveBeenCalled()
      expect(store.count().unread).toBe(0)

      publishMp4Ready('take-1', store)
      // E2E 2026-11-01: "MP4 ready" still said "Long recordings can take
      // several minutes to save as MP4". The entry is rebuilt, never merged.
      expect(entry('mp4:take-1')).toMatchObject({
        state: 'done',
        tone: 'done',
        title: 'MP4 ready',
        detail: undefined,
        actions: [{ id: 'reveal', kind: 'fix' }]
      })
      expect(door.show).toHaveBeenCalledTimes(1)
      expect(door.show.mock.calls[0][1]).toBe(8_000)
      expect(store.count().unread).toBe(1)
    })

    it('while a recording runs, "MP4 ready" only raises the number', () => {
      live = true
      publishMp4Ready('take-1', store)
      expect(door.show).not.toHaveBeenCalled()
      expect(store.count().unread).toBe(1)
    })

    it('a retried export drops the failed entry Retry action while it saves', async () => {
      const retry = vi.fn()
      publishMp4ExportFailed('take-2', retry, undefined, store)
      expect(entry('mp4:take-2')).toMatchObject({
        state: 'failed',
        tone: 'warning',
        title: 'MP4 export failed',
        actions: [{ id: 'retry', label: 'Retry export', kind: 'fix' }]
      })
      await store.runAction('mp4:take-2', 'retry')
      expect(retry).toHaveBeenCalledTimes(1)
      publishMp4Finalizing('take-2', 'Saving MP4…', store)
      expect(entry('mp4:take-2')).toMatchObject({
        state: 'running',
        title: 'Saving MP4…',
        actions: []
      })
    })

    // E2E 2026-11-01 (Linux, low disk): the export after Stop was refused for
    // want of space, and the notice only said the recording was safe, so
    // Retry was the one step offered and it could not work until space was
    // freed.
    it('a failed export for want of disk space says how much and what to do', () => {
      const refusal =
        'Not enough disk space to finish the MP4 (needs 541 MB, 148 MB free). Your recording is safe as MKV; free some space and use Export MP4.'
      publishMp4ExportFailed('take-3', () => undefined, refusal, store)
      expect(entry('mp4:take-3')?.detail).toBe(refusal)
    })

    it('any other export failure keeps its reason out of the entry', () => {
      publishMp4ExportFailed('take-4', () => undefined, 'ffmpeg exited with status 1', store)
      expect(entry('mp4:take-4')?.detail).toBe('Your original recording is safe.')
    })
  })

  it('a clean cut that is ready has Review; one that never started opens Clean cut', async () => {
    const review = vi.fn()
    const open = vi.fn()
    publishCleanCutReady({ id: 'job-1', title: 'Clean cut ready' }, review, store)
    publishCleanCutReady({ id: 'job-1', title: 'Clean cut ready' }, review, store)
    publishCleanCutAutoFailed('take-1', 'The transcript is missing.', open, store)
    expect(entry('clean-cut:job-1')).toMatchObject({
      tone: 'done',
      title: 'Clean cut ready',
      detail: 'The original is kept.',
      occurrences: 1,
      actions: [{ id: 'review', label: 'Review', kind: 'door' }]
    })
    expect(entry('clean-cut-auto:take-1')).toMatchObject({
      tone: 'warning',
      title: "Your clean cut didn't start",
      detail: 'The transcript is missing.',
      actions: [{ label: 'Open Clean cut', kind: 'door' }]
    })
    await store.runAction('clean-cut:job-1', 'review')
    await store.runAction('clean-cut-auto:take-1', 'open-clean-cut')
    expect(review).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('a cloud recording that downloaded, or failed, is one entry per recording', async () => {
    const revealDownload = vi.fn()
    publishCloudDownloadFailed(
      'rec-1',
      { title: "Couldn't download the cloud recording", description: 'Try again.' },
      store
    )
    expect(entry('cloud-download:rec-1')).toMatchObject({
      tone: 'warning',
      title: "Couldn't download the cloud recording",
      detail: 'Try again.'
    })
    publishCloudDownloadSaved('rec-1', revealDownload, store)
    expect(store.snapshot()).toHaveLength(1)
    expect(entry('cloud-download:rec-1')).toMatchObject({
      tone: 'done',
      title: 'Cloud recording saved'
    })
    await store.runAction('cloud-download:rec-1', 'reveal')
    expect(revealDownload).toHaveBeenCalledTimes(1)
  })

  describe('clips', () => {
    it('a clip saved by a key answers the press: a 4 s toast while live and quiet', () => {
      live = true
      publishClipSaved({ saveId: 's1', replaySessionId: 'clip-1', complete: true }, '0:30', store)
      publishClipSaved({ saveId: 's2', replaySessionId: 'clip-2', complete: false }, '0:12', store)
      expect(entry('clip:s1')).toMatchObject({
        tone: 'done',
        title: 'Clip saved',
        detail: 'Last 0:30.',
        actions: [{ id: 'reveal' }]
      })
      expect(entry('clip:s2')?.detail).toBe('Last 0:12, the buffer was still filling.')
      expect(door.show).toHaveBeenCalledTimes(2)
      expect(door.show.mock.calls[0][1]).toBe(4_000)
    })

    it('a clip that could not be saved also answers the press', () => {
      live = true
      publishClipSaveFailed({ saveId: 's3', message: 'The recordings folder is full.' }, store)
      expect(entry('clip:s3')).toMatchObject({
        tone: 'warning',
        title: "Couldn't save the clip",
        detail: 'The recordings folder is full.'
      })
      expect(door.show).toHaveBeenCalledTimes(1)
    })

    it('Clips stopped, or could not start, is one condition that resolves when they are on', () => {
      publishClipsStopped('The session ended.', store)
      publishClipsCouldNotStart('Screen Recording access is off.', store)
      expect(store.snapshot()).toHaveLength(1)
      expect(entry('clips')).toMatchObject({
        state: 'open',
        tone: 'warning',
        title: "Clips couldn't start",
        detail: 'Screen Recording access is off.',
        actions: [{ label: 'Open Output', kind: 'door' }]
      })
      resolveClips(store)
      expect(entry('clips')).toMatchObject({ state: 'resolved', title: 'Clips are on again' })
      // With nothing open, the ring coming on is not news.
      store.reset()
      resolveClips(store)
      expect(store.snapshot()).toEqual([])
    })
  })
})
