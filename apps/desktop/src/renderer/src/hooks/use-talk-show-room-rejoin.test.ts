// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { CloudStatus } from '@/lib/backend'
import type { TalkShowRoomSnapshot } from '@/lib/talk-show-room'

import { useTalkShowRoomController, type TalkShowRoomControllerDeps } from './use-talk-show-room'

// 2026-11-19: the backend restarted in the middle of a live talk show. The
// room join is keyed on the backend client, so the host left the room, and
// stayed out until they pressed Resume. The Studio now sends that Resume
// itself, once per backend, for the room it had open.

const room = vi.hoisted(() => ({
  options: [] as { initiallyMuted?: boolean; initiallyCameraOff?: boolean }[],
  snapshots: [] as ((snapshot: TalkShowRoomSnapshot) => void)[],
  connected: 0,
  disconnected: 0
}))
vi.mock('@/lib/talk-show-room', () => {
  class TalkShowRoomClient {
    constructor(
      options: (typeof room.options)[number] & {
        onSnapshot: (snapshot: TalkShowRoomSnapshot) => void
      }
    ) {
      room.options.push(options)
      room.snapshots.push(options.onSnapshot)
    }
    async updateMicrophone(): Promise<void> {}
    setGraphics(): void {}
    failGraphics(): void {}
    async sendStage(): Promise<void> {}
    async connect(): Promise<void> {
      room.connected += 1
    }
    async disconnect(): Promise<void> {
      room.disconnected += 1
    }
  }
  return { TalkShowRoomClient }
})
const told = vi.hoisted(() => ({
  publishCloudRejoin: vi.fn(),
  withdrawCloudRejoin: vi.fn(),
  publishCloudController: vi.fn(),
  withdrawCloudController: vi.fn()
}))
vi.mock('@/lib/notifications/sources/cloud', () => told)

const base = {
  phase: 'live',
  entitled: true,
  settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [1800] },
  connected: true,
  directFallbackAvailable: false
} as const
/** The room open on this computer, as the backend that holds it reports it. */
const openRoom = {
  ...base,
  show: { id: 'sh_talk', nodeId: 'managed', resumable: false, kind: 'talk' },
  controller: { controllerEpoch: 3, needsEnable: [], restoredViews: 0, cleared: [] },
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
    live: true
  }
} as unknown as CloudStatus
/** The same show on a restarted backend: found, its controller epoch renewed, no room. */
const resumable = {
  ...base,
  show: { id: 'sh_talk', nodeId: 'managed', resumable: true, kind: 'talk' },
  controller: { controllerEpoch: 3, needsEnable: [], restoredViews: 0, cleared: [] }
} as unknown as CloudStatus

type FakeBackend = BackendClient & { requestTyped: ReturnType<typeof vi.fn> }
function backend(answers: {
  status: CloudStatus
  resume?: () => Promise<CloudStatus>
}): FakeBackend {
  return {
    request: vi.fn(async () => ({})),
    requestTyped: vi.fn(async (method: string) => {
      // Each answer is its own object, as off the socket.
      if (method === 'cloud.status') return { ...answers.status }
      if (method === 'cloud.room.resume')
        return { ...(await (answers.resume ?? (async () => openRoom))()) }
      return {}
    }),
    on: vi.fn(() => () => {})
  } as unknown as FakeBackend
}
const resumes = (client: FakeBackend): number =>
  client.requestTyped.mock.calls.filter(([method]) => method === 'cloud.room.resume').length

let root: Root
let container: HTMLDivElement
let status: CloudStatus | null
let shown: { rejoining: boolean }
let render: (patch: Partial<TalkShowRoomControllerDeps>) => void

function Host({ value }: { value: TalkShowRoomControllerDeps }): ReactElement | null {
  shown = useTalkShowRoomController(value)
  return null
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  room.options = []
  room.snapshots = []
  room.connected = 0
  room.disconnected = 0
  Object.values(told).forEach((mock) => mock.mockReset())
  status = openRoom
  let current: TalkShowRoomControllerDeps = {
    client: null,
    cloudStatus: status,
    // The provider's commit: the status reaches the hook on the next render.
    commitCloudStatus: (next) => {
      status = next
      render({})
    },
    cameraId: null,
    microphoneId: null,
    devices: [],
    outputs: () => [] as never,
    hostShape: () => undefined as never,
    onCameraReturned: () => {},
    onError: vi.fn(),
    previewReplacedOverride: false
  }
  render = (patch) => {
    current = { ...current, cloudStatus: status, ...patch }
    if ('cloudStatus' in patch) status = patch.cloudStatus ?? null
    root.render(createElement(Host, { value: current }))
  }
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  }
}

/** The room open and joined under `first`; then that backend goes away. */
async function restartFrom(first: FakeBackend, patch: Partial<TalkShowRoomControllerDeps> = {}) {
  act(() => render({ client: first, ...patch }))
  await settle()
  expect(room.connected).toBe(1)
  act(() => render({ client: null }))
  await settle()
  expect(room.disconnected).toBe(1)
}

describe('back in the room after a backend restart', () => {
  it('resumes the room exactly once on the new backend and joins it again', async () => {
    const first = backend({ status: openRoom })
    await restartFrom(first)
    const second = backend({ status: resumable })
    // The provider still holds the last backend's status when the client changes.
    act(() => render({ client: second }))
    await settle()
    expect(resumes(second)).toBe(1)
    expect(resumes(first)).toBe(0)
    expect(room.connected).toBe(2)
    expect(told.publishCloudRejoin).toHaveBeenCalledWith('running')
    // "Back in your show" waits for the room itself.
    expect(told.publishCloudRejoin).not.toHaveBeenCalledWith('done')
    act(() => room.snapshots.at(-1)?.({ state: 'connected' } as TalkShowRoomSnapshot))
    await settle()
    expect(told.publishCloudRejoin).toHaveBeenLastCalledWith('done')
    // Later statuses from the same backend never ask again.
    act(() => render({ cloudStatus: { ...openRoom } }))
    await settle()
    expect(resumes(second)).toBe(1)
    expect(shown.rejoining).toBe(false)
  })

  it('keeps a muted microphone muted and a camera that was off, off', async () => {
    await restartFrom(backend({ status: openRoom }), { microphoneMuted: true, cameraOff: true })
    act(() => render({ client: backend({ status: resumable }) }))
    await settle()
    expect(room.options).toHaveLength(2)
    expect(room.options[1]).toMatchObject({ initiallyMuted: true, initiallyCameraOff: true })
  })

  it('says it is reconnecting while the resume runs', async () => {
    await restartFrom(backend({ status: openRoom }))
    let finish!: (status: CloudStatus) => void
    const second = backend({
      status: resumable,
      resume: () => new Promise<CloudStatus>((resolve) => (finish = resolve))
    })
    act(() => render({ client: second }))
    await settle()
    expect(shown.rejoining).toBe(true)
    finish(openRoom)
    await settle()
    expect(shown.rejoining).toBe(false)
  })

  it('never resumes a show another device took over', async () => {
    await restartFrom(backend({ status: openRoom }))
    const elsewhere = {
      ...resumable,
      controller: undefined,
      onAir: {
        name: 'iPhone',
        kind: 'phone',
        source: 'host',
        waiting: false,
        thisDevice: false,
        since: '2026-11-19T14:21:19.000Z'
      }
    } as CloudStatus
    const second = backend({ status: elsewhere })
    act(() => render({ client: second }))
    await settle()
    expect(resumes(second)).toBe(0)
    expect(room.connected).toBe(1)
    expect(told.publishCloudRejoin).not.toHaveBeenCalled()
    expect(shown.rejoining).toBe(false)
  })

  it('does not resume a room the host closed before the restart', async () => {
    const first = backend({ status: openRoom })
    act(() => render({ client: first }))
    await settle()
    // Close the room: the backend that held it reports it closed.
    act(() => render({ cloudStatus: { ...resumable, show: undefined } as CloudStatus }))
    await settle()
    act(() => render({ client: null }))
    const second = backend({ status: resumable })
    act(() => render({ client: second }))
    await settle()
    expect(resumes(second)).toBe(0)
  })

  it('leaves a room the backend still holds to the join (a reconnect, not a restart)', async () => {
    await restartFrom(backend({ status: openRoom }))
    const second = backend({ status: openRoom })
    act(() => render({ client: second }))
    await settle()
    expect(resumes(second)).toBe(0)
    expect(room.connected).toBe(2)
    expect(told.publishCloudRejoin).not.toHaveBeenCalled()
  })

  it('backs off, gives up, tells the host, and never asks that backend again', async () => {
    await restartFrom(backend({ status: openRoom }))
    vi.useFakeTimers()
    const second = backend({
      status: resumable,
      resume: () => Promise.reject(new Error('The camera is still returning.'))
    })
    act(() => render({ client: second }))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(resumes(second)).toBe(3)
    expect(told.publishCloudRejoin).toHaveBeenLastCalledWith('failed')
    expect(shown.rejoining).toBe(false)
    // The Resume notice is the host's now: more statuses change nothing.
    act(() => render({ cloudStatus: { ...resumable } }))
    await act(async () => vi.advanceTimersByTimeAsync(60_000))
    expect(resumes(second)).toBe(3)
    expect(room.connected).toBe(1)
  })
})
