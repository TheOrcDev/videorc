// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { CloudStatus } from '@/lib/backend'

import {
  guestActionWords,
  useTalkShowRoomController,
  type TalkShowRoomControllerDeps
} from './use-talk-show-room'

// The lazy room client (`lib/talk-show-room.ts`, livekit-client with it)
// resolves only when a test releases it, so a test can unmount the Studio
// while a join is still loading it.
const room = vi.hoisted(() => {
  let release!: () => void
  const loaded = new Promise<void>((resolve) => {
    release = resolve
  })
  return { loaded, release, constructed: 0, connected: 0 }
})
vi.mock('@/lib/talk-show-room', async () => {
  await room.loaded
  class TalkShowRoomClient {
    constructor() {
      room.constructed += 1
    }
    async sendStage(): Promise<void> {}
    async connect(): Promise<void> {
      room.connected += 1
    }
    async disconnect(): Promise<void> {}
  }
  return { TalkShowRoomClient }
})

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  room.constructed = 0
  room.connected = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const openRoom = {
  phase: 'live',
  show: { id: 'sh_talk', nodeId: 'local-1', resumable: false, kind: 'talk' },
  room: {
    phase: 'open',
    doorOpen: false,
    declinedCount: 0,
    stage: { layout: 'solo', onStage: ['host:sh_talk'] },
    hostAway: false,
    connected: true,
    client: 'connected',
    returnEnabled: false,
    stageSet: true,
    live: false
  }
} as unknown as CloudStatus

function deps(onError: TalkShowRoomControllerDeps['onError']): TalkShowRoomControllerDeps {
  return {
    client: { requestTyped: vi.fn(async () => ({})) } as unknown as BackendClient,
    cloudStatus: openRoom,
    commitCloudStatus: () => {},
    cameraId: null,
    microphoneId: null,
    devices: [],
    outputs: () => [] as never,
    hostShape: () => undefined as never,
    onCameraReturned: () => {},
    onError,
    previewReplacedOverride: false
  }
}

function Host({ value }: { value: TalkShowRoomControllerDeps }): ReactElement | null {
  useTalkShowRoomController(value)
  return null
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))

describe('the host room join', () => {
  // The join awaits the lazy room client. A Studio that unmounts meanwhile
  // must not get a client built (or a "Couldn't join the room" toast from a
  // document that is gone) after it left: nothing would disconnect it, and
  // the toast lands in whatever shows next.
  it('stops a join still loading the room client once the Studio unmounts', async () => {
    const onError = vi.fn()
    act(() => root.render(createElement(Host, { value: deps(onError) })))
    act(() => root.unmount())
    room.release()
    await settle()
    expect(room.constructed).toBe(0)
    expect(onError).not.toHaveBeenCalled()
    root = createRoot(container)
  })

  it('joins an open room while the Studio is mounted', async () => {
    const onError = vi.fn()
    act(() => root.render(createElement(Host, { value: deps(onError) })))
    await settle()
    expect(room.constructed).toBe(1)
    expect(room.connected).toBe(1)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('guestActionWords', () => {
  it('names the guest, never the room', () => {
    expect(guestActionWords('mute')).toBe('mute the guest')
    expect(guestActionWords('allow-screen-share')).toBe('let the guest share their screen')
    expect(guestActionWords('disallow-screen-share')).toBe("stop the guest's screen share")
  })
})
