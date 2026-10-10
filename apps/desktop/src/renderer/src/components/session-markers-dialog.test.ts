// @vitest-environment happy-dom
import { act, createElement, useImperativeHandle, type Ref, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMarker, SessionSummary } from '@/lib/backend'
import type { SessionPlayerHandle } from './media/session-player'
import { TooltipProvider } from './ui/tooltip'
import { SessionMarkersDialog } from './session-markers-dialog'

const mocked = vi.hoisted(() => ({
  core: { connection: { port: 1, token: 'test' }, wsStatus: 'connected' },
  request: vi.fn(),
  seek: vi.fn(),
  close: vi.fn(),
  player: vi.fn(),
  toast: { message: vi.fn(), dismiss: vi.fn() },
  // The Undo window, held still: the test runs or undoes it by hand.
  undoable: { run: null as null | (() => void), undo: vi.fn(), flush: vi.fn() }
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core
}))
vi.mock('@/lib/toast', () => ({ toast: mocked.toast }))
vi.mock('@/lib/undoable-action', () => ({
  scheduleUndoableAction: (run: () => void) => {
    mocked.undoable.run = run
    return { undo: mocked.undoable.undo, flush: mocked.undoable.flush, state: 'pending' }
  }
}))
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
  mocked.request.mockResolvedValue({ markers: [marker] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
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
    expect(document.body.textContent).toContain('no local video')
    expect(document.body.textContent).toContain('00:00:12')
    expect(document.querySelector('[data-slot="marker-timeline"]')).toBeTruthy()
    expect(mocked.player).not.toHaveBeenCalled()
  })
  // Plan 174 S0.3 (E-8): a marker cannot be made again, so a delete hides it
  // and runs only once the Undo toast's window passes.
  it('hides a deleted marker at once and deletes it only after the Undo window', async () => {
    await mount()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete Shadcn New Library"]')!.click()
    )
    expect(document.body.textContent).not.toContain('Shadcn New Library')
    expect(mocked.request).not.toHaveBeenCalledWith('session.marker.delete', expect.anything())
    expect(mocked.toast.message).toHaveBeenCalledWith(
      'Marker deleted · Shadcn New Library',
      expect.objectContaining({ id: 'marker-delete-m1', duration: 5000 })
    )
    await act(async () => mocked.undoable.run?.())
    expect(mocked.request).toHaveBeenCalledWith('session.marker.delete', {
      sessionId: 's1',
      markerId: 'm1'
    })
  })
  it('brings a deleted marker back on Undo and never deletes it', async () => {
    await mount()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete Shadcn New Library"]')!.click()
    )
    const options = mocked.toast.message.mock.calls.at(-1)?.[1] as {
      action: { label: string; onClick: () => void }
    }
    expect(options.action.label).toBe('Undo')
    await act(async () => options.action.onClick())
    expect(mocked.undoable.undo).toHaveBeenCalledOnce()
    expect(mocked.toast.dismiss).toHaveBeenCalledWith('marker-delete-m1')
    expect(mocked.request).toHaveBeenLastCalledWith('session.markers.list', { sessionId: 's1' })
    expect(mocked.request).not.toHaveBeenCalledWith('session.marker.delete', expect.anything())
    expect(document.body.textContent).toContain('Shadcn New Library')
  })
  it('runs a waiting delete when its client goes away, and drops the Undo', async () => {
    await mount()
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete Shadcn New Library"]')!.click()
    )
    const connected = mocked.core
    mocked.core = { ...connected, wsStatus: 'closed' }
    try {
      await mount()
      expect(mocked.undoable.flush).toHaveBeenCalledOnce()
      expect(mocked.toast.dismiss).toHaveBeenCalledWith('marker-delete-m1')
    } finally {
      mocked.core = connected
    }
  })
  it('shows a read failure and retries without claiming an empty timeline', async () => {
    mocked.request.mockRejectedValueOnce(new Error('Storage unavailable'))
    await mount()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable')
    expect(document.body.textContent).not.toContain('No markers yet')
    await act(async () => button('Try again').click())
    expect(document.body.textContent).toContain('Shadcn New Library')
  })
  it('shows timestamps without proportional pins when the capture duration is unknown', async () => {
    await mount({ ...session, mode: 'stream', mp4Path: undefined, durationMs: undefined })
    expect(document.body.textContent).toContain('00:00:12')
    expect(document.body.textContent).toContain('Shadcn New Library')
    expect(document.querySelector('[data-slot="marker-timeline"]')).toBeNull()
  })
})
