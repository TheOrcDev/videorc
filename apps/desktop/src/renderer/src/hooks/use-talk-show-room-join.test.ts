// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { CloudStatus } from '@/lib/backend'
import { IDLE_TALK_SHOW_SNAPSHOT } from '@/lib/talk-show-context'
import type { TalkShowRoomSnapshot } from '@/lib/talk-show-room'

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
  return {
    loaded,
    release,
    constructed: 0,
    connected: 0,
    disconnected: 0,
    connect: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn<() => Promise<void>>(),
    reports: [] as ((state: 'connected') => void)[],
    snapshots: [] as ((snapshot: TalkShowRoomSnapshot) => void)[]
  }
})
vi.mock('@/lib/talk-show-room', async () => {
  await room.loaded
  class TalkShowRoomClient {
    constructor({
      report,
      onSnapshot
    }: {
      report: (state: 'connected') => void
      onSnapshot: (snapshot: TalkShowRoomSnapshot) => void
    }) {
      room.constructed += 1
      room.reports.push(report)
      room.snapshots.push(onSnapshot)
    }
    async sendStage(): Promise<void> {}
    async connect(): Promise<void> {
      room.connected += 1
      await room.connect()
    }
    async disconnect(): Promise<void> {
      room.disconnected += 1
      await room.disconnect()
    }
  }
  return { TalkShowRoomClient }
})

let root: Root
let container: HTMLDivElement
let shown: TalkShowRoomSnapshot

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  room.constructed = 0
  room.connected = 0
  room.disconnected = 0
  room.connect.mockReset().mockResolvedValue(undefined)
  room.disconnect.mockReset().mockResolvedValue(undefined)
  room.reports = []
  room.snapshots = []
  shown = IDLE_TALK_SHOW_SNAPSHOT
})

afterEach(async () => {
  await act(async () => root.unmount())
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
    client: {
      requestTyped: vi.fn(async () => ({})),
      on: vi.fn(() => () => {})
    } as unknown as BackendClient,
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
  shown = useTalkShowRoomController(value).room
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
    await settle()
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

  it('cancels a join when the room closes while its media grant is pending', async () => {
    let grant!: () => void
    const setTalkShowMediaGrant = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            grant = resolve
          })
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('videorc', { setTalkShowMediaGrant })
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() => root.render(createElement(Host, { value: { ...value, cloudStatus: null } })))
    grant()
    await settle()
    expect(room.constructed).toBe(0)
    expect(room.connected).toBe(0)
    expect(setTalkShowMediaGrant).toHaveBeenLastCalledWith({ video: false, screenSourceId: null })
    expect(value.onError).not.toHaveBeenCalled()
  })

  it('starts only the new join when the room closes and reopens during a grant', async () => {
    let grant!: () => void
    const setTalkShowMediaGrant = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            grant = resolve
          })
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('videorc', { setTalkShowMediaGrant })
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() => root.render(createElement(Host, { value: { ...value, cloudStatus: null } })))
    act(() => root.render(createElement(Host, { value })))
    grant()
    await settle()
    expect(room.constructed).toBe(1)
    expect(room.connected).toBe(1)
    expect(setTalkShowMediaGrant.mock.calls.map(([permission]) => permission.video)).toEqual([
      true,
      false,
      true
    ])
  })

  it('revokes the media grant on unmount', async () => {
    const setTalkShowMediaGrant = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('videorc', { setTalkShowMediaGrant })
    act(() => root.render(createElement(Host, { value: deps(vi.fn()) })))
    await settle()
    act(() => root.unmount())
    await settle()
    expect(room.disconnected).toBe(1)
    expect(setTalkShowMediaGrant).toHaveBeenLastCalledWith({ video: false, screenSourceId: null })
    root = createRoot(container)
  })

  it('leaves the old show and joins a different open show', async () => {
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() =>
      root.render(
        createElement(Host, {
          value: {
            ...value,
            cloudStatus: { ...openRoom, show: { ...openRoom.show!, id: 'sh_new' } }
          }
        })
      )
    )
    await settle()
    expect(room.disconnected).toBe(1)
    expect(room.connected).toBe(2)
  })

  it('ignores a late join failure after the backend goes offline', async () => {
    let reject!: (reason: Error) => void
    room.connect.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail
        })
    )
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() => root.render(createElement(Host, { value: { ...value, client: null } })))
    reject(new Error('The old socket closed'))
    await settle()
    expect(room.disconnected).toBe(1)
    expect(value.onError).not.toHaveBeenCalled()
    expect(value.client!.requestTyped).not.toHaveBeenCalled()
    act(() => root.render(createElement(Host, { value })))
    await settle()
    expect(room.connected).toBe(2)
  })

  it('keeps the connection across status and callback updates for the same show', async () => {
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() =>
      root.render(
        createElement(Host, {
          value: {
            ...value,
            cloudStatus: { ...openRoom },
            onError: vi.fn(),
            commitCloudStatus: vi.fn()
          }
        })
      )
    )
    await settle()
    expect(room.connected).toBe(1)
    expect(room.disconnected).toBe(0)
  })

  it('waits for the old disconnect before granting a reopened room', async () => {
    let leave!: () => void
    room.disconnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          leave = resolve
        })
    )
    const setTalkShowMediaGrant = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('videorc', { setTalkShowMediaGrant })
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() => root.render(createElement(Host, { value: { ...value, cloudStatus: null } })))
    act(() => root.render(createElement(Host, { value })))
    await settle()
    expect(room.connected).toBe(1)
    expect(setTalkShowMediaGrant).toHaveBeenCalledTimes(1)
    leave()
    await settle()
    expect(room.connected).toBe(2)
    expect(setTalkShowMediaGrant.mock.calls.map(([permission]) => permission.video)).toEqual([
      true,
      false,
      true
    ])
  })

  it('does not restore an open status from a retired client report', async () => {
    let respond!: (status: CloudStatus) => void
    const value = deps(vi.fn())
    value.commitCloudStatus = vi.fn()
    vi.mocked(value.client!.requestTyped).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve
        })
    )
    act(() => root.render(createElement(Host, { value })))
    await settle()
    room.reports[0]('connected')
    act(() => root.render(createElement(Host, { value: { ...value, cloudStatus: null } })))
    respond(openRoom)
    await settle()
    expect(value.commitCloudStatus).not.toHaveBeenCalled()
  })

  it('clears the old snapshot immediately when changing shows during a slow leave', async () => {
    let leave!: () => void
    room.disconnect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          leave = resolve
        })
    )
    const value = deps(vi.fn())
    act(() => root.render(createElement(Host, { value })))
    await settle()
    act(() =>
      room.snapshots[0]({
        ...IDLE_TALK_SHOW_SNAPSHOT,
        state: 'connected',
        identity: 'host:sh_talk'
      })
    )
    expect(shown.state).toBe('connected')
    act(() =>
      root.render(
        createElement(Host, {
          value: {
            ...value,
            cloudStatus: { ...openRoom, show: { ...openRoom.show!, id: 'sh_new' } }
          }
        })
      )
    )
    try {
      expect(shown).toEqual(IDLE_TALK_SHOW_SNAPSHOT)
    } finally {
      leave()
      await settle()
    }
  })
})

describe('guestActionWords', () => {
  it('names the guest, never the room', () => {
    expect(guestActionWords('mute')).toBe('mute the guest')
    expect(guestActionWords('allow-screen-share')).toBe('let the guest share their screen')
    expect(guestActionWords('disallow-screen-share')).toBe("stop the guest's screen share")
  })
})
