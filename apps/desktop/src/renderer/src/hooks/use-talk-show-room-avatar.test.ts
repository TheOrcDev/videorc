// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BackendClient } from '@/backendClient'
import type { CloudStatus } from '@/lib/backend'

import { useTalkShowRoomController, type TalkShowRoomControllerDeps } from './use-talk-show-room'

const room = vi.hoisted(() => ({ avatar: [] as unknown[] }))
vi.mock('@/lib/talk-show-room', () => {
  class TalkShowRoomClient {
    async updateMicrophone(): Promise<void> {}
    setGraphics(): void {}
    failGraphics(): void {}
    async sendStage(): Promise<void> {}
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    setAvatar(content: unknown): void {
      room.avatar.push(content)
    }
    setAvatarMotion(): void {}
    failAvatar(): void {}
  }
  return { TalkShowRoomClient }
})
// One layer per call, named after the bubble it carries.
vi.mock('@/lib/buddy-overlay', () => ({
  renderCloudAvatar: async ({ bubble }: { bubble: { text: string } | null }) => [
    { kind: bubble ? `bubble:${bubble.text}` : 'avatar' }
  ]
}))

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  room.avatar = []
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

const rect = { x: 0.6, y: 0.5, w: 0.3, h: 0.4 }
const client = {
  request: vi.fn(async () => ({})),
  requestTyped: vi.fn(async () => ({})),
  on: vi.fn(() => () => {})
} as unknown as BackendClient
const onError = vi.fn()
function deps(bubble: string | null, show = true): TalkShowRoomControllerDeps {
  return {
    client,
    cloudStatus: openRoom,
    commitCloudStatus: () => {},
    cameraId: null,
    microphoneId: null,
    devices: [],
    outputs: () => [] as never,
    hostShape: () => undefined as never,
    onCameraReturned: () => {},
    onError,
    previewReplacedOverride: false,
    avatar: {
      persona: { id: 'default', avatar: { kind: 'builtin' } } as never,
      snapshot: {
        state: bubble ? 'talk' : 'idle',
        bubble: bubble ? { text: bubble, until: '2099-01-01T00:00:00Z' } : null
      } as never,
      layout: {
        showOnStream: show,
        showInRecording: show,
        horizontal: rect,
        vertical: rect
      } as never
    }
  }
}

function Host({ value }: { value: TalkShowRoomControllerDeps }): ReactElement | null {
  useTalkShowRoomController(value)
  return null
}

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
const kinds = () =>
  room.avatar.map((c) =>
    c === null ? null : (c as { h: { kind: string }[] }).h.map((l) => l.kind).join()
  )

describe('the room avatar on outputs', () => {
  // QA F2 follow-up: a clear before each new picture blanked the avatar on
  // every program page whenever the Sidekick started or stopped talking.
  it('keeps the last picture while a new bubble is drawn, and clears a hide at once', async () => {
    act(() => root.render(createElement(Host, { value: deps(null) })))
    for (let i = 0; i < 5; i++) await settle() // the lazy room client joins
    act(() => root.render(createElement(Host, { value: deps(null) })))
    await settle()
    act(() => root.render(createElement(Host, { value: deps('hello') })))
    await settle()
    act(() => root.render(createElement(Host, { value: deps(null) })))
    await settle()
    expect(kinds()).toEqual(['avatar', 'bubble:hello', 'avatar'])
    act(() => root.render(createElement(Host, { value: deps(null, false) })))
    await settle()
    expect(kinds().slice(3)).toEqual([null, ''])
  })
})
