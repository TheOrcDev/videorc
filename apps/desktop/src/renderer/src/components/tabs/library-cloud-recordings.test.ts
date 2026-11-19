// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudRecordingDownloadEvent, CloudRecordingItem } from '@/lib/backend'
import { resetCloudDownloads } from '@/lib/cloud-recording-downloads'
import { noteCloudRecording, resetCloudRecordingWatch } from '@/lib/cloud-recordings-watch'

import { LibraryCloudRecordings } from './library-cloud-recordings'

// Plan 234: the Library's Cloud tab. It lists the account's cloud recordings
// newest first in the Local tab's table, downloads a managed one as a job with
// its progress in the row, opens every one on videorc.com, and shows the
// stopped take as processing until its row is listed.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  client: null as unknown
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioDiagnostics: () => ({ client: mocked.client }),
  useStudioCloud: () => ({ cloudStatus: null })
}))

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }))
// Plan 250: a download that finished or failed out of the streamer's hands is
// an entry behind the bell. The door to the store is stubbed here.
const work = vi.hoisted(() => ({
  publishCloudDownloadFailed: vi.fn(),
  publishCloudDownloadSaved: vi.fn()
}))
vi.mock('@/lib/notify', () => ({
  withWorkNotifications: (run: (source: typeof work) => void) => run(work)
}))
vi.mock('@/lib/toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/toast')>()
  return { ...actual, toast: Object.assign(vi.fn(), toasts) }
})

function item(id: string, overrides: Partial<CloudRecordingItem> = {}): CloudRecordingItem {
  return {
    id,
    showId: 'show_1',
    orientation: 'h',
    startedAt: '2026-11-10T12:04:00Z',
    expiresAt: '2026-12-10T12:04:00Z',
    seconds: 754,
    bytes: 1_000_000,
    ...overrides
  }
}

type Handler = (payload: unknown) => void

function fakeClient(lists: CloudRecordingItem[][]) {
  const handlers = new Map<string, Set<Handler>>()
  const calls: Array<{ method: string; params: unknown }> = []
  let listIndex = 0
  const client = {
    calls,
    requestTyped: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'cloud.recordings.list') {
        const recordings = lists[Math.min(listIndex, lists.length - 1)] ?? []
        listIndex += 1
        return { recordings }
      }
      if (method === 'cloud.recordings.download') return { jobId: 'job_1' }
      if (method === 'cloud.recordings.cancelDownload') return { ok: true }
      throw new Error(`unexpected ${method}`)
    }),
    on: (event: string, handler: Handler) => {
      const set = handlers.get(event) ?? new Set<Handler>()
      set.add(handler)
      handlers.set(event, set)
      return () => set.delete(handler)
    },
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    listCalls: () => calls.filter(({ method }) => method === 'cloud.recordings.list').length
  }
  return client
}

let root: Root
let container: HTMLDivElement
const openOAuthUrl = vi.fn(async (_url: string) => undefined)
const revealCloudDownload = vi.fn(async (_jobId: string) => undefined)
const authorizeOutputDirectory = vi.fn(async (_handle: string) => ({
  capabilityId: 'cap_1',
  displayName: 'Videos'
}))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.platform = 'darwin'
  openOAuthUrl.mockClear()
  revealCloudDownload.mockClear()
  authorizeOutputDirectory.mockClear()
  toasts.success.mockClear()
  toasts.error.mockClear()
  ;(window as unknown as { videorc: unknown }).videorc = {
    openOAuthUrl,
    revealCloudDownload,
    authorizeOutputDirectory
  }
  mocked.core = {
    account: { status: 'signed-in' },
    settings: {},
    wsStatus: 'connected'
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetCloudDownloads()
  resetCloudRecordingWatch()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(LibraryCloudRecordings))
  })
}

function rows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="library-cloud-recording"]')]
}

function button(row: HTMLElement, label: string): HTMLButtonElement {
  const found = [...row.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(label)
  )
  if (!found) throw new Error(`no ${label} button in ${row.textContent}`)
  return found
}

async function openMenu(row: HTMLElement): Promise<HTMLElement[]> {
  const trigger = row.querySelector<HTMLElement>('button[aria-label="Cloud recording actions"]')
  if (!trigger) throw new Error('no actions menu')
  await act(async () => trigger.click())
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

function labels(items: HTMLElement[]): string[] {
  return items.map((item) => item.textContent?.trim() ?? '')
}

async function emit(client: ReturnType<typeof fakeClient>, event: CloudRecordingDownloadEvent) {
  await act(async () => client.emit('cloud.recordings.download', event))
}

describe('Library → Cloud recordings', () => {
  it('asks a signed-out streamer to sign in, and lists nothing', async () => {
    const client = fakeClient([[item('a')]])
    mocked.client = client
    mocked.core = { ...mocked.core, account: { status: 'signed-out' } }
    await render()
    expect(container.textContent).toContain('Sign in to see your cloud recordings.')
    expect(client.listCalls()).toBe(0)
    expect(rows()).toHaveLength(0)
  })

  it('refreshes when opened and lists the newest take first, with its facts', async () => {
    const client = fakeClient([
      [
        item('older', { startedAt: '2026-11-01T10:00:00Z', format: 'mp4' }),
        item('newer', { startedAt: '2026-11-12T10:00:00Z', format: 'segments', orientation: 'v' })
      ]
    ])
    mocked.client = client
    await render()
    expect(client.listCalls()).toBe(1)
    const [first, second] = rows()
    expect(first.dataset.recordingId).toBe('newer')
    expect(first.textContent).toContain('Cloud take')
    expect(first.textContent).toContain('Vertical')
    expect(first.textContent).toContain('12:34')
    expect(first.textContent).toContain('Kept until')
    expect(second.dataset.recordingId).toBe('older')
    expect(second.textContent).toContain('Horizontal')
  })

  it('says when there are none yet, and when the list fails', async () => {
    mocked.client = fakeClient([[]])
    await render()
    expect(container.textContent).toContain('No cloud recordings yet')

    act(() => root.unmount())
    root = createRoot(container)
    mocked.client = {
      on: () => () => {},
      requestTyped: vi.fn(async () => {
        throw new Error('boom')
      })
    }
    await render()
    const alert = container.querySelector('[data-testid="library-cloud-recordings-error"]')
    expect(alert?.textContent).toContain("Couldn't load your cloud recordings")
    expect(alert?.textContent).toContain('Try again')
  })

  it('opens a node recording on videorc.com, where it downloads', async () => {
    mocked.client = fakeClient([[item('node', { format: 'mp4' })]])
    await render()
    expect(rows()[0].dataset.cloudStatus).toBe('on-web')
    expect(rows()[0].textContent).toContain('On videorc.com')
    await act(async () => button(rows()[0], 'Open on videorc.com').click())
    expect(openOAuthUrl).toHaveBeenCalledWith(expect.stringMatching(/\/account#cloud-recordings$/))
  })

  it('opens any recording on videorc.com from its menu', async () => {
    mocked.client = fakeClient([[item('managed', { format: 'segments' })]])
    await render()
    const items = await openMenu(rows()[0])
    expect(labels(items)).toEqual(['Open on videorc.com', 'Download to Library', 'Show markers'])
    await act(async () => items[0].click())
    expect(openOAuthUrl).toHaveBeenCalledWith(expect.stringMatching(/\/account#cloud-recordings$/))
  })

  it('downloads a managed recording as a job: progress, Cancel, then Show in Finder', async () => {
    const client = fakeClient([[item('rec_1', { format: 'segments' })]])
    mocked.client = client
    mocked.core = { ...mocked.core, settings: { outputDirectoryHandle: 'handle_1' } }
    await render()

    await act(async () => button(rows()[0], 'Download').click())
    expect(authorizeOutputDirectory).toHaveBeenCalledWith('handle_1')
    expect(client.calls).toContainEqual({
      method: 'cloud.recordings.download',
      params: { id: 'rec_1', outputDirectoryCapability: 'cap_1' }
    })

    await emit(client, {
      jobId: 'job_1',
      recordingId: 'rec_1',
      state: 'running',
      doneSegments: 3,
      totalSegments: 12
    })
    expect(rows()[0].textContent).toContain('Downloading 25%')
    expect(rows()[0].dataset.cloudStatus).toBe('downloading')

    await act(async () => button(rows()[0], 'Cancel').click())
    expect(client.calls).toContainEqual({
      method: 'cloud.recordings.cancelDownload',
      params: { jobId: 'job_1' }
    })
    await emit(client, { jobId: 'job_1', recordingId: 'rec_1', state: 'cancelled' })
    expect(button(rows()[0], 'Download')).toBeDefined()

    await emit(client, { jobId: 'job_2', recordingId: 'rec_1', state: 'running' })
    expect(rows()[0].textContent).toContain('Downloading…')
    await emit(client, {
      jobId: 'job_2',
      recordingId: 'rec_1',
      state: 'done',
      path: '/Videos/talk-2026-11-10-1204-h.mp4'
    })
    expect(rows()[0].textContent).toContain('Downloaded')
    // In view, the row is the news: no success toast.
    expect(toasts.success).not.toHaveBeenCalled()
    await act(async () => button(rows()[0], 'Show in Finder').click())
    expect(revealCloudDownload).toHaveBeenCalledWith('job_2')
  })

  it('names a failure in a notification, withholding text that is not its own, and offers Try again', async () => {
    const client = fakeClient([[item('rec_1', { format: 'segments' })]])
    mocked.client = client
    await render()
    await act(async () => button(rows()[0], 'Download').click())
    expect(client.calls).toContainEqual({
      method: 'cloud.recordings.download',
      params: { id: 'rec_1' }
    })
    await emit(client, {
      jobId: 'job_1',
      recordingId: 'rec_1',
      state: 'failed',
      error: 'FFmpeg could not make the MP4: (address withheld) 403'
    })
    expect(rows()[0].textContent).toContain('Download failed')
    expect(button(rows()[0], 'Try again')).toBeDefined()
    expect(work.publishCloudDownloadFailed).toHaveBeenLastCalledWith(
      'rec_1',
      expect.objectContaining({
        title: "Couldn't download the cloud recording",
        description: 'Try again. If it keeps happening, export a support bundle from Health.'
      })
    )
    await emit(client, {
      jobId: 'job_1',
      recordingId: 'rec_1',
      state: 'failed',
      error: 'Recording segment 4 could not be downloaded.'
    })
    expect(work.publishCloudDownloadFailed).toHaveBeenLastCalledWith(
      'rec_1',
      expect.objectContaining({
        title: "Couldn't download the cloud recording",
        description: "Part of the recording didn't download. Try again."
      })
    )
  })

  it('says a download that finishes after the Library closed', async () => {
    const client = fakeClient([[item('rec_1', { format: 'segments' })]])
    mocked.client = client
    await render()
    await act(async () => button(rows()[0], 'Download').click())
    act(() => root.unmount())
    root = createRoot(container)
    client.emit('cloud.recordings.download', {
      jobId: 'job_1',
      recordingId: 'rec_1',
      state: 'done',
      path: '/Videos/a.mp4'
    })
    expect(work.publishCloudDownloadSaved).toHaveBeenCalledWith('rec_1', expect.any(Function))
    // Back in the Library, the row still knows.
    await render()
    expect(rows()[0].textContent).toContain('Downloaded')
  })

  it('after Stop recording, asks every 5 s until the new take is listed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-11-14T12:10:00Z'))
    noteCloudRecording({ active: true, since: '2026-11-14T12:00:00Z' })
    noteCloudRecording({ active: false })
    const take = item('take', { startedAt: '2026-11-14T12:00:01Z', format: 'segments' })
    const client = fakeClient([[item('old')], [item('old')], [take, item('old')]])
    mocked.client = client
    await render()
    expect(client.listCalls()).toBe(1)
    // The take the cloud is still saving has a row of its own meanwhile.
    expect(
      container.querySelector('[data-testid="library-cloud-processing"]')?.textContent
    ).toContain('Processing')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(client.listCalls()).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(client.listCalls()).toBe(3)
    expect(rows()[0].dataset.recordingId).toBe('take')
    expect(container.querySelector('[data-testid="library-cloud-processing"]')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(client.listCalls()).toBe(3)
  })
})

it('opens the registered local take and does not offer an expired cloud download', async () => {
  const client = fakeClient([
    [
      item('local', { format: 'segments', localSessionId: 'cloud-take-local' }),
      item('expired', { format: 'segments', availability: 'expired' })
    ]
  ])
  mocked.client = client
  await render()
  const local = rows().find((row) => row.dataset.recordingId === 'local')!
  const expired = rows().find((row) => row.dataset.recordingId === 'expired')!
  const navigate = vi.fn()
  window.addEventListener('videorc:navigate-workspace', navigate)
  await act(async () => button(local, 'Open in Library').click())
  expect(navigate.mock.calls[0][0].detail).toEqual({
    tab: 'library',
    sessionId: 'cloud-take-local'
  })
  window.removeEventListener('videorc:navigate-workspace', navigate)
  expect(expired.dataset.cloudStatus).toBe('expired')
  expect(expired.textContent).toContain('Expired')
  expect(expired.textContent).not.toContain('Kept until')
  // Plan 249 S19: the show's markers stay readable; nothing downloads.
  expect(expired.querySelector('[data-cloud-action]')).toBeNull()
  expect(labels(await openMenu(expired))).toEqual(['Open on videorc.com', 'Show markers'])
})

it('hands Open in Library to the Library when it is given, for the Local tab', async () => {
  mocked.client = fakeClient([[item('local', { format: 'segments', localSessionId: 'sess_9' })]])
  const onOpenLocal = vi.fn()
  await act(async () => {
    root.render(createElement(LibraryCloudRecordings, { onOpenLocal }))
  })
  expect(rows()[0].textContent).toContain('Downloaded')
  await act(async () => button(rows()[0], 'Open in Library').click())
  expect(onOpenLocal).toHaveBeenCalledWith('sess_9')
})
