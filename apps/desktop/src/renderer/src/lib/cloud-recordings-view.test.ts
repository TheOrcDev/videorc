import { cloudRecordingAvailability, cloudRowView, cloudTakeLabel } from './cloud-recordings-view'
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
    // Plan 234 copy check: the segment's number is said plainly.
    expect(knownCloudDownloadRefusal('Recording segment 7 could not be downloaded.')).toBe(
      "Part of the recording didn't download. Try again."
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

  it('keeps waiting past a take from a minute before that was already listed', () => {
    // Plan 234 smoke: two takes inside the clock allowance. The first one's
    // row, listed when the second stopped, is not the second take's row.
    const stop = { sinceMs: since, stoppedAtMs: stoppedAt }
    const earlier = item('earlier', { startedAt: '2026-11-14T11:59:30Z' })
    const take = item('take', { startedAt: '2026-11-14T12:00:02Z' })
    const listedAtStop = new Set(['earlier'])
    expect(awaitingCloudRecording(stop, [earlier], stoppedAt + 5000, listedAtStop)).toBe(true)
    expect(awaitingCloudRecording(stop, [earlier, take], stoppedAt + 10_000, listedAtStop)).toBe(
      false
    )
    // Without a list from the stop (the Library opened later), any take in
    // the window counts, as before.
    expect(awaitingCloudRecording(stop, [earlier], stoppedAt + 5000)).toBe(false)
  })
})

it('S20 distinguishes unknown history, record-only, multiple intervals and expiry', () => {
  expect(cloudTakeLabel(item('old', { liveIntervalIds: [] }))).toBe('Cloud take')
  expect(cloudTakeLabel(item('solo', { associationKnown: true, liveIntervalIds: [] }))).toBe(
    'Record-only take'
  )
  expect(cloudTakeLabel(item('two', { associationKnown: true, liveIntervalIds: ['A', 'B'] }))).toBe(
    'Take · 2 live intervals'
  )
  expect(cloudRecordingAvailability(item('old'), Date.parse('2027-01-01'))).toBe('expired')
  expect(cloudRecordingAvailability(item('missing', { availability: 'missing' }))).toBe('missing')
  expect(
    reduceCloudDownload(new Map(), {
      recordingId: 'rec',
      jobId: 'job',
      state: 'done',
      localSessionId: 'local'
    }).get('rec')
  ).toEqual({ state: 'done', jobId: 'job', localSessionId: 'local' })
})

describe('cloudRowView: a cloud recording as its Library row', () => {
  const now = Date.parse('2026-11-19T12:00:00Z')
  const kept = Date.parse('2026-12-14T12:04:00Z')

  it('downloads a managed one here, and sends a node one to videorc.com', () => {
    expect(cloudRowView(item('a', { format: 'segments' }), null, now)).toEqual({
      status: { kind: 'in-cloud' },
      statusLabel: 'In the cloud',
      statusDetail: null,
      keptUntilMs: kept,
      action: 'download'
    })
    expect(cloudRowView(item('b', { format: 'mp4' }), null, now)).toMatchObject({
      status: { kind: 'on-web' },
      statusLabel: 'On videorc.com',
      keptUntilMs: kept,
      action: 'open-web'
    })
  })

  it('says a download as it goes: starting, a percent, Cancel, then Try again', () => {
    const managed = item('a', { format: 'segments' })
    expect(cloudRowView(managed, { state: 'starting' }, now)).toMatchObject({
      statusLabel: 'Starting…',
      action: null
    })
    expect(
      cloudRowView(managed, { state: 'running', jobId: 'job_1', done: 1, total: 4 }, now)
    ).toMatchObject({
      status: { kind: 'downloading', jobId: 'job_1', percent: 25 },
      statusLabel: 'Downloading 25%',
      action: 'cancel'
    })
    expect(cloudRowView(managed, { state: 'running', jobId: 'job_1' }, now).statusLabel).toBe(
      'Downloading…'
    )
    expect(cloudRowView(managed, { state: 'failed', jobId: 'job_1' }, now)).toMatchObject({
      statusLabel: 'Download failed',
      action: 'retry'
    })
  })

  it('a copy on this computer wins, even when the cloud copy is gone', () => {
    expect(
      cloudRowView(item('a', { localSessionId: 'sess_1', availability: 'expired' }), null, now)
    ).toMatchObject({
      status: { kind: 'downloaded', localSessionId: 'sess_1', jobId: null },
      statusLabel: 'Downloaded',
      action: 'open-local'
    })
    expect(
      cloudRowView(
        item('b', { format: 'segments' }),
        { state: 'done', jobId: 'job_2', localSessionId: 'sess_2' },
        now
      )
    ).toMatchObject({
      status: { kind: 'downloaded', localSessionId: 'sess_2', jobId: 'job_2' },
      action: 'open-local'
    })
    // A finished download the Library hasn't listed yet shows its file.
    expect(
      cloudRowView(item('c', { format: 'segments' }), { state: 'done', jobId: 'job_3' }, now)
    ).toMatchObject({
      status: { kind: 'downloaded', localSessionId: null, jobId: 'job_3' },
      action: 'reveal'
    })
  })

  it('a gone cloud copy says so, with no action and no kept-until date', () => {
    expect(
      cloudRowView(item('a', { format: 'segments', expiresAt: '2026-11-01T00:00:00Z' }), null, now)
    ).toEqual({
      status: { kind: 'expired' },
      statusLabel: 'Expired',
      statusDetail: 'The cloud copy was deleted on the date it was kept until.',
      keptUntilMs: null,
      action: null
    })
    expect(cloudRowView(item('b', { availability: 'missing' }), null, now)).toMatchObject({
      statusLabel: 'File missing',
      keptUntilMs: null,
      action: null
    })
  })
})
