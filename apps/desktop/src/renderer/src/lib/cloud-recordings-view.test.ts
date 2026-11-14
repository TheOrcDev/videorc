import { afterEach, describe, expect, it } from 'vitest'

import type { CloudRecordingDownloadEvent, CloudRecordingItem } from '@/lib/backend'
import {
  awaitingCloudRecording,
  cloudDownloadPercent,
  cloudOrientationLabel,
  CLOUD_RECORDING_POLL_WINDOW_MS,
  downloadsOnThisComputer,
  knownCloudDownloadRefusal,
  reduceCloudDownload,
  sortCloudRecordings,
  type CloudDownloads
} from '@/lib/cloud-recordings-view'
import {
  lastCloudRecordingStop,
  noteCloudRecording,
  resetCloudRecordingWatch,
  subscribeCloudRecordingStop
} from '@/lib/cloud-recordings-watch'

// Plan 234: the Library's Cloud recordings section, as pure rules.

function item(id: string, overrides: Partial<CloudRecordingItem> = {}): CloudRecordingItem {
  return {
    id,
    showId: 'show_1',
    orientation: 'h',
    startedAt: '2026-11-14T12:04:00Z',
    expiresAt: '2026-12-14T12:04:00Z',
    seconds: 754,
    bytes: 1_000_000,
    ...overrides
  }
}

function event(overrides: Partial<CloudRecordingDownloadEvent>): CloudRecordingDownloadEvent {
  return { jobId: 'job_1', recordingId: 'rec_1', state: 'running', ...overrides }
}

afterEach(() => resetCloudRecordingWatch())

describe('the cloud recordings list', () => {
  it('lists the newest take first, an unreadable time last', () => {
    const sorted = sortCloudRecordings([
      item('old', { startedAt: '2026-11-01T10:00:00Z' }),
      item('bad', { startedAt: 'not a time' }),
      item('new', { startedAt: '2026-11-14T10:00:00Z' })
    ])
    expect(sorted.map(({ id }) => id)).toEqual(['new', 'old', 'bad'])
  })

  it('downloads only a segments recording on this computer', () => {
    expect(downloadsOnThisComputer(item('a', { format: 'segments' }))).toBe(true)
    expect(downloadsOnThisComputer(item('b', { format: 'mp4' }))).toBe(false)
    expect(downloadsOnThisComputer(item('c'))).toBe(false)
  })

  it('names the orientation in words', () => {
    expect(cloudOrientationLabel('h')).toBe('Horizontal')
    expect(cloudOrientationLabel('v')).toBe('Vertical')
  })
})

describe('a download job in its row', () => {
  it('follows running, done, failed and cancelled by recording id', () => {
    let downloads: CloudDownloads = new Map([['rec_1', { state: 'starting' }]])
    downloads = reduceCloudDownload(downloads, event({ doneSegments: 3, totalSegments: 12 }))
    expect(downloads.get('rec_1')).toEqual({ state: 'running', jobId: 'job_1', done: 3, total: 12 })
    expect(cloudDownloadPercent(downloads.get('rec_1')!)).toBe(25)
    downloads = reduceCloudDownload(downloads, event({ state: 'done', path: '/videos/a.mp4' }))
    expect(downloads.get('rec_1')).toEqual({ state: 'done', jobId: 'job_1' })
    downloads = reduceCloudDownload(downloads, event({ state: 'failed', error: 'x' }))
    expect(downloads.get('rec_1')).toEqual({ state: 'failed', jobId: 'job_1' })
    downloads = reduceCloudDownload(downloads, event({ state: 'cancelled' }))
    expect(downloads.has('rec_1')).toBe(false)
  })

  it('has no percent before the total is known', () => {
    expect(cloudDownloadPercent({ state: 'running', jobId: 'j', done: 0 })).toBeNull()
    expect(cloudDownloadPercent({ state: 'running', jobId: 'j', done: 9, total: 4 })).toBe(100)
  })

  it("shows the backend's own sentences and withholds anything else", () => {
    expect(knownCloudDownloadRefusal('Recording segment 7 could not be downloaded.')).toBe(
      'Recording segment 7 could not be downloaded.'
    )
    expect(knownCloudDownloadRefusal("There isn't enough space to save the recording.")).toBe(
      "There isn't enough space to save the recording."
    )
    expect(
      knownCloudDownloadRefusal('FFmpeg could not make the MP4: (address withheld) 403')
    ).toBeNull()
    expect(knownCloudDownloadRefusal(undefined)).toBeNull()
  })
})

describe('after Stop recording on a cloud talk show', () => {
  const since = Date.parse('2026-11-14T12:00:00Z')
  const stoppedAt = since + 600_000

  it('remembers when the recording started and stopped', () => {
    const heard: number[] = []
    subscribeCloudRecordingStop(() => heard.push(1))
    noteCloudRecording({ active: false }, since - 1000)
    expect(lastCloudRecordingStop()).toBeNull()
    noteCloudRecording({ active: true, since: '2026-11-14T12:00:00Z' }, since + 5000)
    noteCloudRecording({ active: true, since: '2026-11-14T12:00:00Z' }, since + 9000)
    noteCloudRecording({ active: false }, stoppedAt)
    expect(lastCloudRecordingStop()).toEqual({ sinceMs: since, stoppedAtMs: stoppedAt })
    expect(heard).toHaveLength(1)
    noteCloudRecording({ active: false }, stoppedAt + 1000)
    expect(heard).toHaveLength(1)
  })

  it('takes the first time it saw the recording when the status has no start', () => {
    noteCloudRecording({ active: true }, since)
    noteCloudRecording({ active: true }, since + 4000)
    noteCloudRecording({ active: false }, stoppedAt)
    expect(lastCloudRecordingStop()).toEqual({ sinceMs: since, stoppedAtMs: stoppedAt })
  })

  it('waits until a take that started then is listed, for up to 2 minutes', () => {
    const stop = { sinceMs: since, stoppedAtMs: stoppedAt }
    const older = item('older', { startedAt: '2026-11-13T12:00:00Z' })
    const take = item('take', { startedAt: '2026-11-14T12:00:02Z' })
    expect(awaitingCloudRecording(null, [], stoppedAt)).toBe(false)
    expect(awaitingCloudRecording(stop, null, stoppedAt + 1000)).toBe(true)
    expect(awaitingCloudRecording(stop, [older], stoppedAt + 5000)).toBe(true)
    expect(awaitingCloudRecording(stop, [older, take], stoppedAt + 10_000)).toBe(false)
    expect(awaitingCloudRecording(stop, [older], stoppedAt + CLOUD_RECORDING_POLL_WINDOW_MS)).toBe(
      false
    )
  })
})
