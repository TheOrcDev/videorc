import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import type { CloudStage, LayoutSettings, Scene, SceneConfigParams, SceneSource } from './backend'
import { defaultCaptureConfig } from './capture'
import { cloudSceneFromNative } from './cloud-scene-native'
import { applySceneToRoom, stageLayoutClearsScene, type RoomSceneRoom } from './cloud-scene-adapter'
import { RoomScenePublisher, type RoomSceneStatus, type SceneContent } from './room-scene-publisher'
import { CAPABILITY_TOPIC } from './room-media-v2'
import { hydrateSceneLibrary, normalizeSavedSceneCloud } from './scene-presets'
import {
  defaultSceneGuests,
  parseSceneSnapshot,
  type SceneSnapshot
} from '../../../shared/cloud-scene'

const layout = (patch: Partial<LayoutSettings> = {}): LayoutSettings => ({
  ...structuredClone(defaultCaptureConfig.layout),
  ...patch
})
const source = (patch: Partial<SceneSource> & Pick<SceneSource, 'id' | 'kind'>): SceneSource => {
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
  return {
    name: patch.id,
    transform,
    defaultTransform: transform,
    visible: true,
    locked: false,
    ...patch
  }
}
/** The shape Rust `scene_from_capture_config` answers for screen + camera. */
const screenCamera = (): Scene => ({
  id: 'scene:default',
  name: 'Default Scene',
  outputs: [],
  sources: [
    source({ id: 'source:base', kind: 'screen' }),
    source({
      id: 'source:camera',
      kind: 'camera',
      transform: {
        x: 0.74,
        y: 0.7,
        width: 0.22,
        height: 0.2475,
        cropLeft: 0.125,
        cropTop: 0.125,
        cropRight: 0.125,
        cropBottom: 0.125
      }
    })
  ]
})

describe('S12 native scene translation', () => {
  it('copies the native frames and crops and the depicted fit, mask and mirror', () => {
    const { scene, needs, skipped } = cloudSceneFromNative({
      scene: screenCamera(),
      layout: layout({
        layoutPreset: 'screen-camera',
        cameraShape: 'rounded',
        cameraCornerRadiusPct: 18,
        cameraMirror: true,
        cameraFit: 'fill'
      }),
      background: null,
      orientation: 'h'
    })
    expect(skipped).toEqual([])
    expect(needs).toEqual({ camera: true, screen: true })
    expect(scene.items).toEqual([
      {
        role: 'screen',
        rect: { x: 0, y: 0, w: 1, h: 1 },
        crop: { l: 0, t: 0, r: 0, b: 0 },
        fit: 'contain',
        mirror: false,
        mask: { shape: 'rectangle' },
        z: 0
      },
      {
        role: 'host-camera',
        rect: { x: 0.74, y: 0.7, w: 0.22, h: 0.2475 },
        crop: { l: 0.125, t: 0.125, r: 0.125, b: 0.125 },
        fit: 'cover',
        mirror: true,
        mask: { shape: 'rounded', radius: 0.18 },
        z: 1
      }
    ])
    expect(scene.guests).toEqual(defaultSceneGuests('h'))
    expect(scene.id).toMatch(/^[0-9a-f]{8}$/)
  })
  it('side by side keeps the camera rectangular (Rust camera_mask) and fills the screen', () => {
    const { scene } = cloudSceneFromNative({
      scene: screenCamera(),
      layout: layout({ layoutPreset: 'side-by-side', cameraShape: 'circle' }),
      background: null,
      orientation: 'h'
    })
    expect(scene.items.map((i) => [i.role, i.fit, i.mask.shape])).toEqual([
      ['screen', 'cover', 'rectangle'],
      ['host-camera', 'cover', 'rectangle']
    ])
  })
  it('a background stage margin moves the screen, not the inset camera', () => {
    const { scene } = cloudSceneFromNative({
      scene: screenCamera(),
      layout: layout({ layoutPreset: 'screen-camera' }),
      background: { visibilityPercent: 20 },
      orientation: 'h'
    })
    expect(scene.items[0].rect).toEqual({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })
    expect(scene.items[1].rect).toEqual({ x: 0.74, y: 0.7, w: 0.22, h: 0.2475 })
  })
  it('names hidden and diagnostic sources instead of faking them', () => {
    const native = screenCamera()
    native.sources[0] = source({ id: 'source:test-pattern', kind: 'test-pattern' })
    native.sources[1].visible = false
    const out = cloudSceneFromNative({
      scene: native,
      layout: layout(),
      background: null,
      orientation: 'h'
    })
    expect(out.scene.items).toEqual([])
    expect(out.skipped.map((s) => s.reason)).toEqual(['test-pattern', 'hidden'])
  })
  it('uses a saved scene extension for guest roles, default otherwise', () => {
    const guests = {
      host: { x: 0, y: 0, w: 0.7, h: 0.7 },
      region: { x: 0.7, y: 0, w: 0.3, h: 1 },
      slots: []
    }
    const translate = (extension: unknown) =>
      cloudSceneFromNative({
        scene: screenCamera(),
        layout: layout(),
        background: null,
        orientation: 'v',
        extension
      }).scene.guests
    expect(translate({ version: 1, guests })).toEqual(guests)
    expect(translate({ version: 9, anything: true })).toEqual(defaultSceneGuests('v'))
  })
})

describe('S12 saved-scene extension', () => {
  const entry = (cloud: unknown) => ({
    version: 1,
    scenes: [
      {
        id: 'a',
        name: 'A',
        createdAt: 'x',
        updatedAt: 'x',
        visual: {
          layout: defaultCaptureConfig.layout,
          sources: {},
          background: null
        },
        cloud
      }
    ]
  })
  it('keeps any bounded versioned extension as saved and drops what is not one', () => {
    const v1 = { version: 1, guests: defaultSceneGuests('h') }
    expect(hydrateSceneLibrary(entry(v1)).library.scenes[0].cloud).toEqual(v1)
    expect(hydrateSceneLibrary(entry({ version: 3, x: [1] })).library.scenes[0].cloud).toEqual({
      version: 3,
      x: [1]
    })
    // Kept as saved; the room adapter falls back to the default guest layout.
    const bad = hydrateSceneLibrary(entry({ version: 1, guests: { host: 1 } }))
    expect(bad.library.scenes[0].cloud).toEqual({ version: 1, guests: { host: 1 } })
    expect(bad.error).toBeNull()
    expect(
      cloudSceneFromNative({
        scene: screenCamera(),
        layout: layout(),
        background: null,
        orientation: 'h',
        extension: bad.library.scenes[0].cloud
      }).scene.guests
    ).toEqual(defaultSceneGuests('h'))
    expect(hydrateSceneLibrary(entry({ version: 0 })).library.scenes[0].cloud).toBeUndefined()
    expect(normalizeSavedSceneCloud({ version: 4, big: 'x'.repeat(5000) })).toBeUndefined()
  })
})

function roomHarness() {
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_0123456789012345678901',
    localParticipant: {
      sid: 'PA_host1',
      streamBytes: vi.fn(async () => ({
        write: vi.fn(async () => {}),
        close: vi.fn(async () => {})
      }))
    },
    remoteParticipants: new Map<string, { identity: string; sid: string }>([
      ['EG_program', { identity: 'EG_program', sid: 'PA_program' }],
      ['g_guest', { identity: 'g_guest', sid: 'PA_guest' }]
    ])
  })
  const statuses: RoomSceneStatus[] = []
  const bodies: SceneSnapshot[] = []
  room.localParticipant.streamBytes.mockImplementation(async () => {
    const chunks: Uint8Array[] = []
    return {
      write: vi.fn(async (bytes: Uint8Array) => {
        chunks.push(bytes)
      }),
      close: vi.fn(async () => {
        bodies.push(JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))))
      })
    }
  })
  const publisher = new RoomScenePublisher(room as unknown as Room, (s) => statuses.push(s))
  const receipt = (identity: string, sid: string, scene: unknown, participant?: unknown): void => {
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(
        JSON.stringify({
          v: 2,
          identity,
          participantSid: sid,
          at: Date.now(),
          ...(scene ? { scene } : {})
        })
      ),
      participant,
      undefined,
      CAPABILITY_TOPIC
    )
  }
  return { room, publisher, statuses, bodies, receipt }
}
const content = (): SceneContent => ({
  h: cloudSceneFromNative({
    scene: screenCamera(),
    layout: layout(),
    background: null,
    orientation: 'h'
  }).scene,
  v: null,
  transition: { kind: 'motion', durationMs: 320 }
})
afterEach(() => vi.useRealTimers())

describe('S12 room scene publisher', () => {
  it('sends only to EG lanes with a scene receipt, never to guests or on participant claims', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = roomHarness()
    h.receipt(
      'EG_program',
      'PA_program',
      { version: 1, output: 'stream', orientation: 'h' },
      { identity: 'g_guest' }
    )
    void h.publisher.commit(content())
    await vi.advanceTimersByTimeAsync(1500)
    expect(h.room.localParticipant.streamBytes).not.toHaveBeenCalled()
    h.receipt('EG_program', 'PA_program', { version: 1, output: 'stream', orientation: 'h' })
    await vi.advanceTimersByTimeAsync(1500)
    const targets = h.room.localParticipant.streamBytes.mock.calls.map(
      (call) => (call as unknown as [{ destinationIdentities: string[] }])[0].destinationIdentities
    )
    expect(targets.flat()).toEqual(['EG_program'])
    const sent = h.bodies.at(-1)!
    expect(parseSceneSnapshot(sent, { ...sent, now: Date.now() })).not.toBeNull()
    expect(sent.scene?.items).toHaveLength(2)
    expect(sent.transition.kind).toBe('motion')
    h.publisher.close()
  })
  it('settles a commit on the rendered revision of every egress, and a vertical lane gets no horizontal scene', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = roomHarness()
    h.room.remoteParticipants.set('EG_vertical', { identity: 'EG_vertical', sid: 'PA_vertical' })
    h.receipt('EG_program', 'PA_program', { version: 1, output: 'stream', orientation: 'h' })
    h.receipt('EG_vertical', 'PA_vertical', { version: 1, output: 'recording', orientation: 'v' })
    const commit = h.publisher.commit(content())
    await vi.advanceTimersByTimeAsync(300)
    const byLane = new Map(h.bodies.map((b) => [b.orientation, b]))
    expect(byLane.get('v')?.scene).toBeNull()
    expect(h.statuses.at(-1)?.state).toBe('waiting')
    for (const [identity, sid, body] of [
      ['EG_program', 'PA_program', byLane.get('h')!],
      ['EG_vertical', 'PA_vertical', byLane.get('v')!]
    ] as const)
      h.receipt(identity, sid, {
        version: 1,
        output: body.output,
        orientation: body.orientation,
        applied: { publisherSid: 'PA_host1', revision: body.revision }
      })
    await vi.advanceTimersByTimeAsync(300)
    const result = await commit
    expect(result.state).toBe('applied')
    expect(Object.keys(result.observed).sort()).toEqual(['EG_program', 'EG_vertical'])
    h.publisher.close()
  })
  it('an unconfirmed page leaves the commit waiting, and a stale ack never counts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = roomHarness()
    h.receipt('EG_program', 'PA_program', {
      version: 1,
      output: 'stream',
      orientation: 'h',
      applied: { publisherSid: 'PA_host1', revision: 999 }
    })
    const commit = h.publisher.commit(content())
    await vi.advanceTimersByTimeAsync(6000)
    expect((await commit).state).toBe('waiting')
    h.publisher.close()
  })
  it('before any egress the scene is a preview, and a newer commit supersedes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = roomHarness()
    h.room.remoteParticipants.delete('EG_program')
    expect((await h.publisher.commit(content())).state).toBe('preview')
    h.room.remoteParticipants.set('EG_program', { identity: 'EG_program', sid: 'PA_program' })
    h.receipt('EG_program', 'PA_program', { version: 1, output: 'stream', orientation: 'h' })
    const first = h.publisher.commit(content())
    const second = h.publisher.commit(null)
    expect((await first).state).toBe('superseded')
    void second
    h.publisher.close()
  })
  it('a hidden program egress known only by its relayed receipt gets the scene and confirms it (QA F2)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const h = roomHarness()
    // LiveKit leaves `hidden: true` recorder grants out of remoteParticipants.
    h.room.remoteParticipants.delete('EG_program')
    const lane = { version: 1, output: 'stream', orientation: 'h' }
    h.receipt('EG_program', 'PA_program', lane, { identity: 'g_guest' })
    expect((await h.publisher.commit(content())).state).toBe('preview')
    h.receipt('EG_program', 'PA_program', lane)
    const commit = h.publisher.commit(content())
    await vi.advanceTimersByTimeAsync(300)
    const targets = h.room.localParticipant.streamBytes.mock.calls.map(
      (call) => (call as unknown as [{ destinationIdentities: string[] }])[0].destinationIdentities
    )
    expect(targets.flat()).toEqual(['EG_program'])
    const sent = h.bodies.at(-1)!
    h.receipt('EG_program', 'PA_program', {
      ...lane,
      applied: { publisherSid: 'PA_host1', revision: sent.revision }
    })
    await vi.advanceTimersByTimeAsync(300)
    expect((await commit).state).toBe('applied')
    h.publisher.close()
  })
  it('rejects a cut with a duration', async () => {
    const h = roomHarness()
    expect(
      (await h.publisher.commit({ ...content(), transition: { kind: 'cut', durationMs: 50 } }))
        .state
    ).toBe('failed')
    h.publisher.close()
  })
})

describe('S12 active-output adapter', () => {
  const stage: CloudStage = { layout: 'side-by-side', onStage: ['host:sh_x', 'g_a'] }
  const make = (patch: Partial<RoomSceneRoom> = {}) => {
    const commits: (SceneContent | null)[] = []
    const stages: CloudStage[] = []
    let room: RoomSceneRoom = {
      identity: 'host:sh_x',
      cameraPublished: true,
      cameraOff: false,
      screenPublished: true,
      stage,
      commitScene: async (c) => {
        commits.push(c)
        return {
          state: 'applied',
          reason: null,
          observed: { EG_a: { revision: 4, output: 'stream', orientation: 'h' } }
        }
      },
      ...patch
    }
    const resolve = vi.fn(async (_params: SceneConfigParams) => screenCamera())
    return {
      commits,
      stages,
      resolve,
      deps: {
        resolve,
        room: () => room,
        setStage: async (next: CloudStage) => {
          stages.push(next)
          room = { ...room, stage: next }
        },
        animate: true,
        readyWaitMs: 0,
        sleep: async () => {}
      }
    }
  }
  const target = (preset: LayoutSettings['layoutPreset'] = 'screen-camera') => ({
    layout: layout({ layoutPreset: preset }),
    sources: { ...defaultCaptureConfig.sources, cameraId: 'cam', screenId: 'scr' },
    background: null,
    video: defaultCaptureConfig.video
  })
  it('resolves at the lane canvas, puts the host screen up, keeps guests and commits once', async () => {
    const h = make()
    const result = await applySceneToRoom(target(), h.deps)
    expect(result).toMatchObject({ ok: true, orientation: 'h' })
    expect(h.resolve.mock.calls[0][0]).toMatchObject({ video: { width: 1920, height: 1080 } })
    expect(h.stages).toEqual([{ ...stage, screen: 'host:sh_x' }])
    expect(h.stages[0].onStage).toEqual(stage.onStage)
    expect(h.commits).toHaveLength(1)
    expect(h.commits[0]).toMatchObject({ v: null, transition: { kind: 'motion', durationMs: 320 } })
  })
  it('a vertical scene goes to the vertical lane at 1080x1920', async () => {
    const h = make()
    const result = await applySceneToRoom(target('vertical-camera-top'), h.deps)
    expect(result.orientation).toBe('v')
    expect(h.resolve.mock.calls[0][0]).toMatchObject({ video: { width: 1080, height: 1920 } })
    expect(h.commits[0]).toMatchObject({ h: null })
  })
  it('refuses, without committing, a scene whose screen is not in the room', async () => {
    const h = make({ screenPublished: false })
    const result = await applySceneToRoom(target(), h.deps)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/Share your screen/)
    expect(h.commits).toHaveLength(0)
  })
  it('a guest screen already up fills the scene screen box; the stage is not touched', async () => {
    const h = make({ screenPublished: false, stage: { ...stage, screen: 'g_a' } })
    expect((await applySceneToRoom(target(), h.deps)).ok).toBe(true)
    expect(h.stages).toEqual([])
  })
  it('an unconfirmed program is not a success', async () => {
    const h = make({
      commitScene: async () => ({
        state: 'waiting',
        reason: 'Scene sent; waiting for each output to draw it.',
        observed: {}
      })
    })
    const result = await applySceneToRoom(target(), h.deps)
    expect(result).toMatchObject({
      ok: false,
      message: 'Scene sent; waiting for each output to draw it.'
    })
  })
  it('an edit overtaken before its commit commits nothing', async () => {
    const h = make()
    const result = await applySceneToRoom(target(), { ...h.deps, current: () => false })
    expect(result).toMatchObject({ ok: false, commit: { state: 'superseded' } })
    expect(h.commits).toHaveLength(0)
  })
  it('only a different room layout clears the scene', () => {
    expect(stageLayoutClearsScene(stage, { ...stage, onStage: ['host:sh_x'] })).toBe(false)
    expect(stageLayoutClearsScene(stage, { ...stage, layout: 'spotlight' })).toBe(true)
  })
})
