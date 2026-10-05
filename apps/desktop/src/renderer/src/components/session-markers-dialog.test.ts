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
  player: vi.fn()
}))
vi.mock('@/hooks/use-studio', () => ({
  useStudioCore: () => mocked.core
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
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Delete Shadcn New Library"]')!.click()
    )
    expect(mocked.request).toHaveBeenCalledWith('session.marker.delete', {
      sessionId: 's1',
      markerId: 'm1'
    })
  })
  it('shows a read failure and retries without claiming an empty timeline', async () => {
    mocked.request.mockRejectedValueOnce(new Error('Storage unavailable'))
    await mount()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Storage unavailable')
    expect(document.body.textContent).not.toContain('No markers yet')
    await act(async () => button('Try again').click())
    expect(document.body.textContent).toContain('Shadcn New Library')
  })
})
