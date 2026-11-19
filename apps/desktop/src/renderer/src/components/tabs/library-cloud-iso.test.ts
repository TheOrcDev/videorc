// @vitest-environment happy-dom
import fixture from '../../../../../../../protocol-fixtures/cloud-source-iso.json'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CloudIsoImportEvent, CloudRecordingItem } from '@/lib/backend'
import { resetCloudDownloads } from '@/lib/cloud-recording-downloads'
import { resetCloudRecordingWatch } from '@/lib/cloud-recordings-watch'

import { LibraryCloudRecordings } from './library-cloud-recordings'

// Plan 249 S22: a cloud take's "Separate files" in the Library. Every file of
// the take is listed, Import is one job per take with the same folder
// capability as a cloud download, progress follows the events, and a
// layout-unknown host camera file is never opened as a picture.

const mocked = vi.hoisted(() => ({
  core: {} as Record<string, unknown>,
  client: null as unknown
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core,
  useStudioCloud: () => ({ cloudStatus: null }),
  useStudioDiagnostics: () => ({ client: mocked.client })
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/workspace-navigation', () => ({ openWorkspaceTab: navigate }))

const SHOW = fixture.valid.showId
const TAKE = fixture.valid.takeId

function recording(id: string, showId: string): CloudRecordingItem {
  return {
    id,
    showId,
    orientation: 'h',
    startedAt: '2026-11-10T12:04:00Z',
    expiresAt: '2099-12-10T12:04:00Z',
    seconds: 60,
    bytes: 1_000_000,
    format: 'segments'
  }
}

type Handler = (payload: unknown) => void

function fakeClient() {
  const handlers = new Map<string, Set<Handler>>()
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    requestTyped: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      if (method === 'cloud.recordings.list')
        return { recordings: [recording('rec_program', SHOW), recording('rec_other', 'sh_other')] }
      if (method === 'cloud.iso.status') {
        const showId = (params as { showId: string }).showId
        return {
          availability: { enabled: false, productionQualified: false },
          iso:
            showId === SHOW
              ? {
                  request: null,
                  lastRefusal: null,
                  guestConsent: [],
                  takes: [
                    { manifest: structuredClone(fixture.valid), programRecordingId: 'rec_program' }
                  ]
                }
              : null
        }
      }
      if (method === 'cloud.iso.imports') return []
      if (method === 'cloud.iso.import') return { jobId: 'job_iso' }
      if (method === 'cloud.iso.cancelImport') return { ok: true }
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
    }
  }
}

let root: Root
let container: HTMLDivElement
const authorizeOutputDirectory = vi.fn(async (_handle: string) => ({
  capabilityId: 'cap_1',
  displayName: 'Videos'
}))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  navigate.mockClear()
  authorizeOutputDirectory.mockClear()
  ;(window as unknown as { videorc: unknown }).videorc = { authorizeOutputDirectory }
  mocked.core = {
    account: { status: 'signed-in' },
    settings: { outputDirectoryHandle: 'handle_1' },
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(client: ReturnType<typeof fakeClient>): Promise<void> {
  mocked.client = client
  await act(async () => {
    root.render(createElement(LibraryCloudRecordings))
  })
  // The status answers settle after the list.
  await act(async () => {})
}

const sections = (): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('[data-testid="library-cloud-iso"]')
]
const file = (entryId: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`[data-entry-id="${entryId}"]`)

async function emit(client: ReturnType<typeof fakeClient>, event: Partial<CloudIsoImportEvent>) {
  await act(async () =>
    client.emit('cloud.iso.import', {
      jobId: 'job_iso',
      showId: SHOW,
      takeId: TAKE,
      error: null,
      localSessionId: null,
      bytes: null,
      ...event
    })
  )
}

describe('Library: separate files of a cloud take (Plan 249 S22)', () => {
  it('lists every file under its take only, with partial, failed and layout unknown said', async () => {
    const client = fakeClient()
    await render(client)
    expect(client.calls.filter((call) => call.method === 'cloud.iso.status')).toHaveLength(2)
    expect(sections()).toHaveLength(1)
    const section = sections()[0] as HTMLElement
    expect(section.dataset.takeId).toBe(TAKE)
    // The section is the row after its own recording's row.
    expect(
      section.closest('[role="row"]')?.previousElementSibling?.getAttribute('data-recording-id')
    ).toBe('rec_program')
    const titles = [
      ...section.querySelectorAll(
        '[data-testid="library-cloud-iso-file"] [data-slot="list-row-title"]'
      )
    ].map((title) => title.textContent)
    expect(titles).toEqual([
      'Host camera',
      'Host microphone',
      'Host microphone (part 2)',
      'Host sounds',
      'Guest camera',
      'Guest microphone'
    ])
    expect(file('host/host-camera/g1')?.textContent).toContain('Layout unknown')
    expect(
      section.querySelectorAll('[data-testid="library-cloud-iso-layout-unknown"]')
    ).toHaveLength(1)
    expect(
      container.querySelector('[data-testid="library-cloud-iso-layout"]')?.textContent
    ).toContain('never shows it as a picture')
    expect(file('g_ann/guest-camera/g1')?.textContent).toContain('Partial')
    expect(file('g_ann/guest-microphone/g1')?.textContent).toContain("Not recorded: Couldn't start")
    // No picture of any kind in the section.
    expect(section.querySelector('img, video, canvas')).toBeNull()
  })

  it('imports the take with the Output folder capability and follows its events', async () => {
    const client = fakeClient()
    await render(client)
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="library-cloud-iso-import"]'
    )
    expect(button?.textContent).toBe('Import separate files')
    await act(async () => button?.click())
    expect(authorizeOutputDirectory).toHaveBeenCalledWith('handle_1')
    expect(client.calls.find((call) => call.method === 'cloud.iso.import')?.params).toEqual({
      showId: SHOW,
      takeId: TAKE,
      outputDirectoryCapability: 'cap_1'
    })
    expect(container.querySelector('[data-testid="library-cloud-iso-import"]')?.textContent).toBe(
      'Importing…'
    )

    await emit(client, { entryId: 'host/host-microphone/g1', state: 'downloading', bytes: 60_000 })
    expect(file('host/host-microphone/g1')?.textContent).toContain('Downloading 50%')

    await emit(client, {
      entryId: 'host/host-microphone/g1',
      state: 'complete',
      bytes: 120_000,
      localSessionId: 'cloud-iso-tk_AbCdEf123456-host-host-microphone-g1'
    })
    await emit(client, { entryId: 'host/host-camera/g1', state: 'complete', bytes: 900_000 })

    const open = [...(file('host/host-microphone/g1')?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent === 'Open in Library'
    )
    await act(async () => open?.click())
    expect(navigate).toHaveBeenCalledWith(
      'library',
      'cloud-iso-tk_AbCdEf123456-host-host-microphone-g1'
    )
    // The layout-unknown camera file is imported, and never opened as a picture.
    expect(file('host/host-camera/g1')?.textContent).toContain('Imported')
    expect(file('host/host-camera/g1')?.querySelector('button')).toBeNull()
  })

  it('cancels a running import by its job', async () => {
    const client = fakeClient()
    await render(client)
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="library-cloud-iso-import"]')
        ?.click()
    )
    await emit(client, { entryId: 'host/host-aux/g1', state: 'downloading', bytes: 1 })
    const cancel = [...(sections()[0]?.querySelectorAll('button') ?? [])].find(
      (candidate) => candidate.textContent === 'Cancel'
    )
    await act(async () => cancel?.click())
    expect(client.calls.find((call) => call.method === 'cloud.iso.cancelImport')?.params).toEqual({
      jobId: 'job_iso'
    })
  })
})
