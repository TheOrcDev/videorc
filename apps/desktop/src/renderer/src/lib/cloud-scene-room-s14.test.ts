import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import type { CloudStage, EffectiveSceneBackground, Scene, SceneSource } from './backend'
import { defaultCaptureConfig } from './capture'
import { cloudSceneFromNative } from './cloud-scene-native'
import { applySceneToRoom, type RoomSceneDeps, type RoomSceneRoom } from './cloud-scene-adapter'
import {
  RoomScenePublisher,
  type PreparedBackgroundAsset,
  type RoomSceneStatus,
  type SceneContent
} from './room-scene-publisher'
import { CAPABILITY_TOPIC } from './room-media-v2'
import { showsSources } from './scenes'
import { SCENE_TOPIC } from '../../../shared/cloud-scene'
import {
  BACKGROUND_ASSET_TOPIC,
  backgroundKey,
  decodeBackgroundAsset,
  type SceneBackground
} from '../../../shared/cloud-background'

const transform = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  cropLeft: 0,
  cropTop: 0,
  cropRight: 0,
  cropBottom: 0
}
const source = (id: string, kind: SceneSource['kind']): SceneSource => ({
  id,
  name: id,
  kind,
  transform,
  defaultTransform: transform,
  visible: true,
  locked: false
})
const screenCamera = (): Scene => ({
  id: 'scene:default',
  name: 'Default Scene',
  outputs: [],
  sources: [source('source:base', 'screen'), source('source:camera', 'camera')]
})
const picture: SceneBackground = {
  kind: 'picture',
  hash: 'ab'.repeat(32),
  mime: 'image/webp',
  width: 2,
  height: 1,
  fit: 'cover',
  crop: { l: 0, t: 0, r: 0, b: 0 }
}
const asset: PreparedBackgroundAsset = {
  hash: picture.hash,
  mime: 'image/webp',
  width: 2,
  height: 1,
  bytes: new Uint8Array([9, 8, 7])
}
const effective: EffectiveSceneBackground = {
  assetId: 'beach',
  managedAssetPath: '/x/beach.webp',
  fit: 'fill',
  scale: 100,
  offsetX: 0,
  offsetY: 0,
  blurPx: 0,
  dimPercent: 0,
  saturationPercent: 100,
  vignettePercent: 0,
  visibilityPercent: 20
}

describe('S14 adapter: the scene names the room screen and its background', () => {
  const stage: CloudStage = { layout: 'side-by-side', onStage: ['host:sh_x'] }
  const make = (patch: Partial<RoomSceneRoom> = {}, deps: Partial<RoomSceneDeps> = {}) => {
    const commits: { content: SceneContent | null; assets?: readonly PreparedBackgroundAsset[] }[] =
      []
    const order: string[] = []
    let room: RoomSceneRoom = {
      identity: 'host:sh_x',
      cameraPublished: true,
      cameraOff: false,
      screenPublished: true,
      screenSourceId: 'screen:1:0',
      stage: { ...stage, screen: 'host:sh_x' },
      commitScene: async (content, assets) => {
        order.push('commit')
        commits.push({ content, assets })
        return { state: 'applied', reason: null, observed: {} }
      },
      ...patch
    }
    const shareScreen = vi.fn(async (want: { capturerId: string }) => {
      order.push(`share:${want.capturerId}`)
      room = { ...room, screenSourceId: want.capturerId }
    })
    return {
      commits,
      order,
      shareScreen,
      deps: {
        resolve: async () => screenCamera(),
        room: () => room,
        setStage: async () => {},
        animate: false,
        readyWaitMs: 0,
        sleep: async () => {},
        shareScreen,
        ...deps
      } satisfies RoomSceneDeps
    }
  }
  const target = (sources: Partial<typeof defaultCaptureConfig.sources> = {}) => ({
    layout: {
      ...structuredClone(defaultCaptureConfig.layout),
      layoutPreset: 'screen-camera' as const
    },
    sources: { ...defaultCaptureConfig.sources, cameraId: 'cam', ...sources },
    background: null as EffectiveSceneBackground | null,
    video: defaultCaptureConfig.video
  })

  it("shares the scene's window first, then commits (Follow and app scenes)", async () => {
    const h = make()
    const result = await applySceneToRoom(
      target({ windowId: 'window:screencapturekit:42' }),
      h.deps
    )
    expect(result).toMatchObject({ ok: true, screen: 'switched', background: 'none' })
    expect(h.order).toEqual(['share:window:42:0', 'commit'])
  })
  it('keeps a share that already shows the scene source', async () => {
    const h = make()
    const result = await applySceneToRoom(target({ screenId: 'screen:screencapturekit:1' }), h.deps)
    expect(result.screen).toBe('kept')
    expect(h.shareScreen).not.toHaveBeenCalled()
  })
  it('a source that cannot be shared refuses the scene and commits nothing', async () => {
    const h = make({}, {})
    h.shareScreen.mockRejectedValueOnce(new Error('the window is gone'))
    const result = await applySceneToRoom(
      target({ windowId: 'window:screencapturekit:42' }),
      h.deps
    )
    expect(result).toMatchObject({ ok: false, screen: 'kept' })
    expect(result.message).toMatch(/window couldn't be shared.*the window is gone/)
    expect(h.commits).toHaveLength(0)
  })
  it('a switch overtaken by a newer change commits nothing', async () => {
    const h = make()
    const result = await applySceneToRoom(target({ windowId: 'window:screencapturekit:42' }), {
      ...h.deps,
      current: () => false
    })
    expect(result).toMatchObject({ ok: false, commit: { state: 'superseded' } })
    expect(h.commits).toHaveLength(0)
  })
  it('an id that does not map keeps the share and says so', async () => {
    const h = make()
    const result = await applySceneToRoom(target({ screenId: 'screen:wgc:0' }), h.deps)
    expect(result).toMatchObject({ ok: true, screen: 'unsupported' })
    expect(result.message).toMatch(/Share it yourself/)
    expect(h.shareScreen).not.toHaveBeenCalled()
  })
  // Plan 231 in a room (owner, 2026-11-19): the scene's own screen wins. A
  // v2 scene's switch carries what it shows over the screen the Studio had;
  // a scene that shows no screen (Camera only, D18) leaves the share alone.
  it('a v2 scene shares its own screen; Camera only keeps the share as it is', async () => {
    const studio = { cameraId: 'cam', screenId: 'screen:screencapturekit:1' }
    const figma = make()
    const shown = await applySceneToRoom(
      target({
        ...studio,
        ...showsSources({ kind: 'window', windowId: 'window:screencapturekit:42' })
      }),
      figma.deps
    )
    expect(shown).toMatchObject({ ok: true, screen: 'switched' })
    expect(figma.order).toEqual(['share:window:42:0', 'commit'])

    const cameraOnly = make(
      {},
      {
        resolve: async () => ({ ...screenCamera(), sources: [source('source:camera', 'camera')] })
      }
    )
    const kept = await applySceneToRoom(
      {
        ...target({ ...studio, ...showsSources({ kind: 'none' }) }),
        layout: {
          ...structuredClone(defaultCaptureConfig.layout),
          layoutPreset: 'camera-only' as const
        }
      },
      cameraOnly.deps
    )
    expect(kept).toMatchObject({ ok: true, screen: 'kept' })
    expect(cameraOnly.shareScreen).not.toHaveBeenCalled()
    expect(cameraOnly.commits).toHaveLength(1)
  })
  it('sends the background inside the scene with its picture', async () => {
    const h = make({}, { background: async () => ({ background: picture, asset }) })
    const result = await applySceneToRoom({ ...target(), background: effective }, h.deps)
    expect(result).toMatchObject({ ok: true, background: 'sent' })
    expect(h.commits[0]!.content?.h?.background).toEqual(picture)
    expect(h.commits[0]!.assets).toEqual([asset])
  })
  it('a background that cannot be prepared is said; the scene still changes without it', async () => {
    const h = make(
      {},
      {
        background: async () => {
          throw new Error('too large')
        }
      }
    )
    const result = await applySceneToRoom({ ...target(), background: effective }, h.deps)
    expect(result).toMatchObject({ ok: true, background: 'failed' })
    expect(result.message).toMatch(/background couldn't be sent.*too large/)
    expect(h.commits[0]!.content?.h).not.toHaveProperty('background')
  })
})

function harness() {
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_0123456789012345678901',
    localParticipant: {
      sid: 'PA_host1',
      streamBytes: vi.fn()
    },
    remoteParticipants: new Map<string, { identity: string; sid: string }>([
      ['EG_program', { identity: 'EG_program', sid: 'PA_program' }],
      ['g_guest', { identity: 'g_guest', sid: 'PA_guest' }]
    ])
  })
  const sent: { topic: string; to: string[]; bytes: Uint8Array }[] = []
  room.localParticipant.streamBytes.mockImplementation(
    async (options: { topic: string; destinationIdentities: string[] }) => {
      const chunks: Uint8Array[] = []
      return {
        write: async (bytes: Uint8Array) => void chunks.push(bytes),
        close: async () =>
          void sent.push({
            topic: options.topic,
            to: options.destinationIdentities,
            bytes: Buffer.concat(chunks)
          })
      }
    }
  )
  const statuses: RoomSceneStatus[] = []
  const publisher = new RoomScenePublisher(room as unknown as Room, (s) => statuses.push(s))
  const receipt = (identity: string, sid: string, scene: unknown): void =>
    void room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({ v: 2, identity, participantSid: sid, at: Date.now(), scene })
      ),
      undefined,
      undefined,
      CAPABILITY_TOPIC
    )
  return { room, publisher, sent, statuses, receipt }
}
const sceneWith = (background: SceneBackground): SceneContent => ({
  h: {
    ...cloudSceneFromNative({
      scene: screenCamera(),
      layout: structuredClone(defaultCaptureConfig.layout),
      background: null,
      orientation: 'h'
    }).scene,
    background
  },
  v: null,
  transition: { kind: 'cut', durationMs: 0 }
})
afterEach(() => vi.useRealTimers())

describe('S14 publisher: background pictures go to program pages only, once, before the scene', () => {
  it('sends the picture before the scene, to the egress lane only, once per connection', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = harness()
    h.receipt('EG_program', 'PA_program', {
      version: 1,
      output: 'stream',
      orientation: 'h',
      background: { version: 1, live: 1 }
    })
    h.publisher.setAssets([asset])
    void h.publisher.commit(sceneWith(picture))
    await vi.advanceTimersByTimeAsync(300)
    expect(h.sent.map((s) => s.topic)).toEqual([BACKGROUND_ASSET_TOPIC, SCENE_TOPIC])
    expect(h.sent.every((s) => s.to.join() === 'EG_program')).toBe(true)
    const decoded = decodeBackgroundAsset(h.sent[0]!.bytes, {
      show: h.room.name,
      publisherSid: 'PA_host1'
    })
    expect(decoded?.header.hash).toBe(picture.hash)
    expect([...decoded!.image]).toEqual([9, 8, 7])
    // A re-send of the same scene does not repeat the picture.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(h.sent.filter((s) => s.topic === BACKGROUND_ASSET_TOPIC)).toHaveLength(1)
    // A reloaded page (new SID) gets it again.
    h.room.remoteParticipants.set('EG_program', { identity: 'EG_program', sid: 'PA_program2' })
    h.receipt('EG_program', 'PA_program2', {
      version: 1,
      output: 'stream',
      orientation: 'h',
      background: { version: 1, live: 1 }
    })
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.sent.filter((s) => s.topic === BACKGROUND_ASSET_TOPIC)).toHaveLength(2)
    h.publisher.close()
  })
  it('a picture that is not ready fails the delivery instead of sending a scene without it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = harness()
    h.receipt('EG_program', 'PA_program', { version: 1, output: 'stream', orientation: 'h' })
    const commit = h.publisher.commit(sceneWith(picture))
    await vi.advanceTimersByTimeAsync(300)
    expect(h.sent).toHaveLength(0)
    expect(h.statuses.at(-1)?.state).toBe('failed')
    void commit
    h.publisher.close()
  })
  it('reports what each page drew and how many pages cannot draw backgrounds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = harness()
    h.room.remoteParticipants.set('EG_old', { identity: 'EG_old', sid: 'PA_old' })
    h.receipt('EG_old', 'PA_old', { version: 1, output: 'recording', orientation: 'h' })
    const live: SceneBackground = {
      kind: 'live',
      id: 'silk',
      look: 'satin',
      dim: 0,
      clock: { anchorAt: 1_800_000_000_000, anchorPhase: 3, rate: 0.5 }
    }
    void h.publisher.commit(sceneWith(live))
    h.receipt('EG_program', 'PA_program', {
      version: 1,
      output: 'stream',
      orientation: 'h',
      background: {
        version: 1,
        live: 1,
        drawn: { key: backgroundKey(live), rendering: 'still', reason: 'no-webgl2' }
      }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.statuses.at(-1)?.background).toEqual({
      wanted: { h: backgroundKey(live), v: 'none' },
      drawn: { EG_program: { key: backgroundKey(live), rendering: 'still', reason: 'no-webgl2' } },
      unsupported: 1,
      productionQualified: false
    })
    h.publisher.close()
  })
})
