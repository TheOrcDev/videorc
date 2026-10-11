// @vitest-environment happy-dom
import { act, createElement, useImperativeHandle, type Ref, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMarker, SessionSummary } from '@/lib/backend'
import type { SessionPlayerHandle } from './media/session-player'
import { TooltipProvider } from './ui/tooltip'
import {
  MARKER_FAILURE_FALLBACK,
  SessionMarkersDialog,
  markerFailureDetail
} from './session-markers-dialog'

const mocked = vi.hoisted(() => ({
  core: {
    connection: { port: 1, token: 'test' } as { port: number; token: string } | null,
    wsStatus: 'connected',
    sessions: [] as SessionSummary[]
  },
  request: vi.fn(),
  seek: vi.fn(),
  close: vi.fn(),
  player: vi.fn(),
  toast: { message: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core
}))
// The toast is held still: each test plays Sonner's part (the toast closing
// by itself, the streamer closing it, the Undo button) through its options.
vi.mock('@/lib/toast', () => ({ toast: mocked.toast }))
vi.mock('@/backendClient', () => ({
  BackendClient: class {
    connect = async (): Promise<void> => {}
    on = (): (() => void) => () => {}
    close = mocked.close
    requestTyped = mocked.request
  }
}))
vi.mock('./media/session-player', () => ({
  SessionPlayer: (props: { handleRef: Ref<SessionPlayerHandle> }): ReactElement => {
    mocked.player(props)
    useImperativeHandle(props.handleRef, () => ({
      seekTo: mocked.seek,
      togglePlayback: vi.fn(),
      seekBy: vi.fn()
    }))
    return createElement('div', { 'data-slot': 'original-player' })
  }
}))

const marker: SessionMarker = {
  id: 'm1',
  sessionId: 's1',
  atSeconds: 12.345,
  label: 'Shadcn New Library',
  source: 'voice',
  createdAt: '2026-10-05T12:00:00Z',
  revision: 1
}
const session: SessionSummary = {
  id: 's1',
  title: 'Capture',
  startedAt: '2026-10-05T12:00:00Z',
  status: 'completed',
  mode: 'record',
  mp4Path: '/videos/original.mp4',
  durationMs: 30_000,
  healthEventCount: 0,
  sessionLogCount: 0,
  aiArtifactCount: 0,
  commentCount: 0
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  mocked.core = { connection: { port: 1, token: 'test' }, wsStatus: 'connected', sessions: [] }
  mocked.request.mockImplementation(async (method: string) =>
    method === 'session.markers.list' ? { markers: [marker] } : {}
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
async function mount(value = session): Promise<void> {
  await act(async () =>
    root.render(
      createElement(
        TooltipProvider,
        null,
        createElement(SessionMarkersDialog, { session: value, onClose: vi.fn() })
      )
    )
  )
}
type DeleteToast = {
  id: string
  duration: number
  onAutoClose: () => void
  onDismiss: () => void
  action: { label: string; onClick: () => void }
}
async function deleteMarker(name = 'Shadcn New Library'): Promise<DeleteToast> {
  await act(async () =>
    document.querySelector<HTMLButtonElement>(`[aria-label="Delete ${name}"]`)!.click()
  )
  return mocked.toast.message.mock.calls.at(-1)?.[1] as DeleteToast
}
function deletes(): unknown[][] {
  return mocked.request.mock.calls.filter(([method]) => method === 'session.marker.delete')
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((node) =>
    node.textContent?.includes(text)
  )
  if (!found) throw new Error(`No button: ${text}`)
  return found
}
describe('saved marker timeline', () => {
  it('seeks the original video at the exact point on every repeated selection', async () => {
    await mount()
    expect(mocked.request).toHaveBeenCalledWith('session.markers.list', { sessionId: 's1' })
    await act(async () => button('Shadcn New Library').click())
    await act(async () => button('Shadcn New Library').click())
    expect(mocked.seek.mock.calls).toEqual([[12_345], [12_345]])
    expect(mocked.player.mock.lastCall?.[0].sessionId).toBe('s1')
  })
  it('retains the titled timestamp and editable metadata for stream-only sessions', async () => {
    await mount({ ...session, mode: 'stream', mp4Path: undefined })
    expect(document.body.textContent).toContain('no video file')
    expect(document.body.textContent).toContain('0:12')
    expect(document.querySelector('[data-slot="marker-timeline"]')).toBeTruthy()
    expect(mocked.player).not.toHaveBeenCalled()
  })
  // Plan 174 S0.3 (E-8): a marker cannot be made again, so a delete hides it
  // and runs only once its Undo toast is gone.
  it('hides a deleted marker at once and deletes it when its Undo toast closes by itself', async () => {
    await mount()
    const toastOptions = await deleteMarker()
    expect(document.body.textContent).not.toContain('Shadcn New Library')
    expect(deletes()).toEqual([])
    expect(mocked.toast.message).toHaveBeenCalledWith(
      'Marker deleted · Shadcn New Library',
      expect.objectContaining({ id: 'marker-delete-m1', duration: 5000 })
    )
    await act(async () => toastOptions.onAutoClose())
    expect(deletes()).toEqual([['session.marker.delete', { sessionId: 's1', markerId: 'm1' }]])
    // Sonner may still report the close: the delete never runs twice.
    await act(async () => toastOptions.onDismiss())
    expect(deletes()).toHaveLength(1)
  })
  // Plan 174 S3.12 (the Phase 0 review's P1): Sonner pauses a toast while the
  // pointer rests on it or the window is hidden. A clock beside the toast kept
  // running and deleted the marker under a live Undo; the toast now drives it.
  it('never deletes while its Undo is still on screen, however long the toast stays', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await mount()
    const toastOptions = await deleteMarker()
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(deletes()).toEqual([])
    await act(async () => toastOptions.action.onClick())
    expect(deletes()).toEqual([])
    expect(document.body.textContent).toContain('Shadcn New Library')
  })
  it('deletes at once when the streamer closes the toast', async () => {
    await mount()
    const toastOptions = await deleteMarker()
    await act(async () => toastOptions.onDismiss())
    expect(deletes()).toHaveLength(1)
  })
  it('brings a deleted marker back on Undo and never deletes it', async () => {
    await mount()
    const toastOptions = await deleteMarker()
    expect(toastOptions.action.label).toBe('Undo')
    await act(async () => toastOptions.action.onClick())
    expect(mocked.toast.dismiss).toHaveBeenCalledWith('marker-delete-m1')
    expect(mocked.request).toHaveBeenLastCalledWith('session.markers.list', { sessionId: 's1' })
    // Sonner closes the toast after its action: still no delete.
    await act(async () => toastOptions.onDismiss())
    expect(deletes()).toEqual([])
    expect(document.body.textContent).toContain('Shadcn New Library')
  })
  it('runs a waiting delete when its client goes away, and drops the Undo', async () => {
    await mount()
    const toastOptions = await deleteMarker()
    mocked.core = { ...mocked.core, wsStatus: 'closed' }
    await mount()
    expect(deletes()).toHaveLength(1)
    expect(mocked.toast.dismiss).toHaveBeenCalledWith('marker-delete-m1')
    await act(async () => toastOptions.onDismiss())
    expect(deletes()).toHaveLength(1)
  })
  // Plan 174 S3.12 (E-9): every failure says what failed, and Retry repeats it.
  it('shows a read failure and retries without claiming an empty timeline', async () => {
    mocked.request.mockRejectedValueOnce(new Error('Storage unavailable'))
    await mount()
    const alert = document.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain("Couldn't load the markers")
    // Raw error text stays in the console.
    expect(alert).not.toContain('Storage unavailable')
    expect(alert).toContain('support bundle')
    expect(document.body.textContent).not.toContain('No markers yet')
    await act(async () => button('Retry').click())
    expect(document.body.textContent).toContain('Shadcn New Library')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
  it("says why a delete failed in the marker's own words, and Retry deletes it again", async () => {
    await mount()
    const toastOptions = await deleteMarker()
    mocked.request.mockImplementation(async (method: string) => {
      if (method === 'session.marker.delete')
        throw Object.assign(new Error('That marker is no longer available.'), {
          code: 'marker-not-found'
        })
      return { markers: [marker] }
    })
    await act(async () => toastOptions.onAutoClose())
    const alert = document.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain("Couldn't delete the marker")
    expect(alert).toContain('That marker is no longer available.')
    // The failed delete put the row back.
    expect(document.body.textContent).toContain('Shadcn New Library')
    mocked.request.mockImplementation(async (method: string) =>
      method === 'session.markers.list' ? { markers: [marker] } : {}
    )
    await act(async () => button('Retry').click())
    expect(deletes()).toHaveLength(2)
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(document.querySelector('[aria-label="Saved markers"]')).toBeNull()
  })
  it('renames in the row, capped at the marker title limit, and Retry repeats a failed rename', async () => {
    await mount()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Rename Shadcn New Library"]')!.click()
    )
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Marker title"]')!
    expect(input.closest('[aria-label="Saved markers"]')).toBeTruthy()
    expect(input.maxLength).toBe(120)
    expect(input.value).toBe('Shadcn New Library')
    mocked.request.mockImplementation(async (method: string) => {
      if (method === 'session.marker.rename') throw new Error('socket closed')
      return { markers: [marker] }
    })
    await act(async () =>
      input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't rename the marker"
    )
    mocked.request.mockImplementation(async (method: string) =>
      method === 'session.markers.list' ? { markers: [{ ...marker, label: 'Shadcn' }] } : {}
    )
    await act(async () => button('Retry').click())
    const renames = mocked.request.mock.calls.filter(
      ([method]) => method === 'session.marker.rename'
    )
    expect(renames).toEqual([
      ['session.marker.rename', { sessionId: 's1', markerId: 'm1', label: 'Shadcn New Library' }],
      ['session.marker.rename', { sessionId: 's1', markerId: 'm1', label: 'Shadcn New Library' }]
    ])
    expect(document.querySelector('input[aria-label="Marker title"]')).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })
  it('leaves a rename on Escape before it leaves the dialog', async () => {
    const onClose = vi.fn()
    await act(async () =>
      root.render(
        createElement(
          TooltipProvider,
          null,
          createElement(SessionMarkersDialog, { session, onClose })
        )
      )
    )
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Rename Shadcn New Library"]')!.click()
    )
    const escape = (): void => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    }
    await act(async () => escape())
    expect(document.querySelector('input[aria-label="Marker title"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => escape())
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('marks the chosen marker selected and names how each was made', async () => {
    await mount()
    await act(async () => button('Shadcn New Library').click())
    const row = document.querySelector('[aria-label="Saved markers"] [data-slot="list-row"]')!
    expect(row.getAttribute('data-selected')).toBe('true')
    expect(row.querySelector('[aria-current="true"]')).toBeTruthy()
    expect(row.querySelector('[data-slot="list-row-context"]')?.textContent).toBe('Voice')
    expect(row.textContent).not.toContain('voice')
  })
  // Plan 174 S3.12 (E-11): the dialog follows the live Library row.
  it('opens playback once the live row says the recording finished', async () => {
    const running: SessionSummary = { ...session, status: 'running' }
    mocked.core = { ...mocked.core, sessions: [running] }
    await mount(running)
    expect(mocked.player).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Still recording')
    mocked.core = { ...mocked.core, sessions: [{ ...running, status: 'completed' }] }
    await mount(running)
    expect(mocked.player).toHaveBeenCalled()
  })
  it('shows timestamps without proportional pins when the capture duration is unknown', async () => {
    await mount({ ...session, mode: 'stream', mp4Path: undefined, durationMs: undefined })
    expect(document.body.textContent).toContain('0:12')
    expect(document.body.textContent).toContain('Shadcn New Library')
    expect(document.querySelector('[data-slot="marker-timeline"]')).toBeNull()
  })
})

describe('markerFailureDetail', () => {
  it("keeps the backend's marker refusals and hides everything else", () => {
    const refusal = Object.assign(new Error('That marker was deleted. It will not be recreated.'), {
      code: 'marker-deleted'
    })
    expect(markerFailureDetail(refusal)).toBe('That marker was deleted. It will not be recreated.')
    const internal = Object.assign(new Error('Marker page size must be 1 to 500.'), {
      code: 'invalid-params'
    })
    expect(markerFailureDetail(internal)).toBe(MARKER_FAILURE_FALLBACK)
    expect(markerFailureDetail(new Error('Backend request failed.'))).toBe(MARKER_FAILURE_FALLBACK)
    expect(markerFailureDetail('nope')).toBe(MARKER_FAILURE_FALLBACK)
  })
})
