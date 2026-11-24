// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'

const play = vi.hoisted(() => vi.fn())
vi.mock('@/lib/join-request-chime', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/join-request-chime')>()),
  playJoinChime: play
}))

const { rendererPlaysJoinChime, useJoinRequestChime } = await import('./use-join-request-chime')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fakeClient() {
  const handlers = new Map<string, () => void>()
  const off = vi.fn()
  const client = {
    on: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler)
      return () => {
        handlers.delete(event)
        off(event)
      }
    })
  }
  return { client: client as unknown as BackendClient, handlers, off }
}

function Probe({
  client,
  roomOpen,
  rendererPlays
}: {
  client: BackendClient | null
  roomOpen: boolean
  rendererPlays: boolean
}): null {
  useJoinRequestChime(client, roomOpen, rendererPlays)
  return null
}

let root: Root | null = null
const render = async (
  client: BackendClient | null,
  roomOpen: boolean,
  rendererPlays = true
): Promise<void> => {
  root ??= createRoot(document.createElement('div'))
  await act(async () => root?.render(createElement(Probe, { client, roomOpen, rendererPlays })))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  play.mockReset()
})

describe('useJoinRequestChime', () => {
  // Plan 260 S1.3: on macOS the backend rings it; the window stays quiet.
  it('leaves the chime to the backend where the backend plays it', async () => {
    const { client, handlers } = fakeClient()
    await render(client, true, false)

    handlers.get('cloud.room.requests')?.()
    expect(play).not.toHaveBeenCalled()
    expect(rendererPlaysJoinChime('darwin')).toBe(false)
    expect(rendererPlaysJoinChime('win32')).toBe(true)
    expect(rendererPlaysJoinChime('linux')).toBe(false)
  })

  it('chimes when someone asks to join an open room', async () => {
    const { client, handlers } = fakeClient()
    await render(client, true)

    handlers.get('cloud.room.requests')?.()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('rings once for a burst of requests', async () => {
    const { client, handlers } = fakeClient()
    await render(client, true)

    handlers.get('cloud.room.requests')?.()
    handlers.get('cloud.room.requests')?.()
    handlers.get('cloud.room.requests')?.()
    expect(play).toHaveBeenCalledTimes(1)
  })

  it('listens only while the room is open', async () => {
    const { client, handlers, off } = fakeClient()
    await render(client, false)
    expect(handlers.has('cloud.room.requests')).toBe(false)

    await render(client, true)
    expect(handlers.has('cloud.room.requests')).toBe(true)

    await render(client, false)
    expect(off).toHaveBeenCalledWith('cloud.room.requests')
    expect(handlers.has('cloud.room.requests')).toBe(false)
  })

  it('needs a backend to listen to', async () => {
    await render(null, true)
    expect(play).not.toHaveBeenCalled()
  })

  it('runs under the room host, the one place the main window holds the room', async () => {
    // `?raw`, not node:fs: under happy-dom `import.meta.url` is not a file URL.
    const { default: source } = await import('../components/studio/talk-show-room-host.tsx?raw')
    expect(source).toContain(
      "useJoinRequestChime(deps.client, deps.cloudStatus?.room?.phase === 'open')"
    )
  })
})
