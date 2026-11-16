import { describe, expect, it } from 'vitest'
import {
  SceneReceiver,
  defaultSceneGuests,
  parseCloudSceneExtension,
  parseSceneCapability,
  parseSceneSnapshot,
  planSceneTiles,
  sceneContentKey,
  sceneEase,
  sceneMotion,
  scenePicture,
  sceneProgress,
  type SceneSnapshot
} from './cloud-scene'
import { parseConsumerCapability } from '../renderer/src/lib/room-media-v2'
import fixture from '../../../../protocol-fixtures/cloud-parity-scenes.json'

type Page = Parameters<typeof parseSceneSnapshot>[1]
const page = fixture.page as Page

describe('S12 cloud scene vectors (mirrored in the web program)', () => {
  it.each(fixture.plan)('plans $name', (one) => {
    expect(
      planSceneTiles(
        one.scene as Parameters<typeof planSceneTiles>[0],
        one.canvas,
        one.roster as Parameters<typeof planSceneTiles>[2]
      )
    ).toEqual(one.expected)
  })
  it.each(fixture.picture)('places $name', (one) => {
    expect(scenePicture(one.frame, one.source, one.crop, one.fit as 'contain' | 'cover')).toEqual(
      one.expected
    )
  })
  it('eases like Rust ease_in_out_cubic', () => {
    for (const [t, value] of fixture.ease) expect(sceneEase(t)).toBeCloseTo(value, 12)
  })
  it.each(fixture.motion)('moves: $name', (one) => {
    expect(
      sceneMotion(one.from as Parameters<typeof sceneMotion>[0], one.to, one.progress)
    ).toEqual(one.expected)
  })
  it.each(fixture.snapshots)('parses: $name', (one) => {
    expect(parseSceneSnapshot(one.snapshot, page) !== null).toBe(one.valid)
  })
})

describe('S12 scene rules', () => {
  it('never drops a guest and keeps the host scene exact with nobody else on stage', () => {
    const scene = fixture.plan[0].scene as Parameters<typeof planSceneTiles>[0]
    for (let n = 0; n <= 6; n++) {
      const tiles = planSceneTiles(
        scene,
        { width: 1920, height: 1080 },
        {
          host: 'host:sh_x',
          guests: Array.from({ length: n }, (_, i) => `g_${i}`),
          screen: 'host:sh_x',
          hostOnStage: true
        }
      )
      expect(tiles.filter((t) => t.role.startsWith('guest:'))).toHaveLength(n)
      if (n === 0)
        expect(tiles.find((t) => t.role === 'screen')?.rect).toEqual({
          x: 0,
          y: 0,
          w: 1920,
          h: 1080
        })
      for (const tile of tiles.filter((t) => t.role.startsWith('guest:')))
        for (const other of tiles.filter((t) => t.role.startsWith('guest:') && t !== tile))
          expect(
            tile.rect.x + tile.rect.w <= other.rect.x ||
              other.rect.x + other.rect.w <= tile.rect.x ||
              tile.rect.y + tile.rect.h <= other.rect.y ||
              other.rect.y + other.rect.h <= tile.rect.y
          ).toBe(true)
    }
  })
  it('the default guest regions sit on the canvas beside the host scene', () => {
    for (const o of ['h', 'v'] as const) {
      const g = defaultSceneGuests(o)
      expect(parseCloudSceneExtension({ version: 1, guests: g })?.guests).toEqual(g)
    }
    expect(parseCloudSceneExtension({ version: 2, guests: defaultSceneGuests('h') })).toBeNull()
  })
  it('extends the S3 capability for EG lanes only', () => {
    const scene = { version: 1, output: 'recording', orientation: 'v' }
    expect(
      parseConsumerCapability({ v: 2, identity: 'EG_rec', participantSid: 'PA_rec', scene })?.scene
    ).toEqual(scene)
    expect(
      parseConsumerCapability({ v: 2, identity: 'g_guest', participantSid: 'PA_g', scene })
    ).toBeNull()
    expect(
      parseConsumerCapability({ v: 2, identity: 'EG_x', participantSid: 'PA_x' })?.scene
    ).toBeUndefined()
    expect(
      parseSceneCapability({ ...scene, applied: { publisherSid: 'nope', revision: 1 } })
    ).toBeNull()
    expect(parseSceneCapability({ ...scene, private: 'x' })).toEqual(scene)
  })
  it('a late join continues the transition at its phase', () => {
    const t = { kind: 'motion' as const, durationMs: 320, applyAt: 1000 }
    expect(sceneProgress(t, 1000)).toBe(0)
    expect(sceneProgress(t, 1160)).toBe(0.5)
    expect(sceneProgress(t, 5000)).toBe(1)
    expect(sceneProgress({ kind: 'cut', durationMs: 0, applyAt: 9e12 }, 0)).toBe(1)
  })
  it('content keys ignore the scene id and revision', () => {
    const scene = fixture.snapshots[0].snapshot.scene as Parameters<typeof sceneContentKey>[0]
    expect(sceneContentKey(scene)).toBe(sceneContentKey({ ...scene!, id: 'ffffffff' } as never))
    expect(sceneContentKey(null)).toBe('none')
  })
})

describe('S12 scene receiver', () => {
  const make = () => {
    let now = page.now
    const shown: (SceneSnapshot | null)[] = []
    const receiver = new SceneReceiver({ show: (s) => shown.push(s), now: () => now })
    const snap = (revision: number, extra: Partial<SceneSnapshot> = {}): SceneSnapshot => ({
      ...(parseSceneSnapshot(fixture.snapshots[0].snapshot, page) as SceneSnapshot),
      revision,
      ...extra
    })
    return { receiver, shown, snap, tick: (ms: number) => (now += ms) }
  }
  it('confirms a revision only once it is drawn, and only the latest', () => {
    const h = make()
    h.receiver.owner('PA_host1')
    expect(h.receiver.accept(h.snap(2))).toBe(true)
    expect(h.receiver.applied).toBeUndefined()
    expect(h.receiver.accept(h.snap(1))).toBe(false)
    h.receiver.rendered(1)
    expect(h.receiver.applied).toBeUndefined()
    h.receiver.rendered(2)
    expect(h.receiver.applied).toEqual({ publisherSid: 'PA_host1', revision: 2 })
    expect(h.receiver.accept(h.snap(3))).toBe(true)
    expect(h.receiver.applied).toBeUndefined()
  })
  it('a new host session, a lease running out or another owner drops the scene', () => {
    const h = make()
    h.receiver.owner('PA_host1')
    h.receiver.accept(h.snap(5))
    h.receiver.rendered(5)
    h.tick(30_000)
    h.receiver.step()
    expect(h.shown.at(-1)).toBeNull()
    expect(h.receiver.applied).toBeUndefined()
    h.tick(-30_000)
    h.receiver.accept(h.snap(6))
    h.receiver.owner('PA_host2')
    expect(h.shown.at(-1)).toBeNull()
    expect(h.receiver.accept(h.snap(7))).toBe(false)
  })
})
