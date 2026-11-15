import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendClient } from '@/backendClient'
import type { CloudRecordingDownloadEvent } from '@/lib/backend'
import {
  attachCloudDownloads,
  cloudDownloads,
  resetCloudDownloads
} from './cloud-recording-downloads'

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn() } }))
vi.mock('@/lib/user-error', () => ({ toastUserError: vi.fn(), UserFacingError: Error }))

afterEach(resetCloudDownloads)
const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

function connection() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const request = vi.fn((): Promise<CloudRecordingDownloadEvent[]> => Promise.resolve([]))
  const client = {
    requestTyped: request,
    on: (name: string, handler: (payload: unknown) => void) => {
      const group = handlers.get(name) ?? new Set()
      group.add(handler)
      handlers.set(name, group)
      return () => group.delete(handler)
    }
  } as unknown as BackendClient
  return {
    client,
    request,
    emit: (name: string, payload: unknown = {}) => handlers.get(name)?.forEach((fn) => fn(payload))
  }
}

const running: CloudRecordingDownloadEvent = {
  recordingId: 'recording',
  jobId: 'job',
  state: 'running'
}

describe('download reconciliation after an interrupted connection', () => {
  it('recovers a terminal event missed while disconnected', async () => {
    const c = connection()
    attachCloudDownloads(c.client)
    await settle()
    c.emit('cloud.recordings.download', running)
    c.request.mockResolvedValue([{ ...running, state: 'done' }])
    c.emit('backend.ready')
    await settle()
    expect(cloudDownloads().get('recording')).toEqual({ jobId: 'job', state: 'done' })
  })

  it('unblocks an unknown job after backend restart or terminal-history eviction', async () => {
    const c = connection()
    attachCloudDownloads(c.client)
    await settle()
    c.emit('cloud.recordings.download', running)
    c.emit('backend.ready')
    await settle()
    expect(cloudDownloads().has('recording')).toBe(false)
  })

  it('does not overwrite an event that arrives while the snapshot is in flight', async () => {
    const c = connection()
    attachCloudDownloads(c.client)
    await settle()
    c.emit('cloud.recordings.download', running)
    let answer!: (events: CloudRecordingDownloadEvent[]) => void
    c.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    c.emit('events.lagged')
    c.emit('cloud.recordings.download', { ...running, state: 'done' })
    answer([running])
    await settle()
    expect(cloudDownloads().get('recording')?.state).toBe('done')
  })
})
