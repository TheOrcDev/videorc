import { describe, it, expect } from 'vitest'
import fixture from '../../../../protocol-fixtures/cloud-parity-graphics.json'
import {
  GraphicsReceiver,
  graphicsOpacity,
  parseGraphicsSnapshot,
  parseStaticCapability,
  graphicsPng,
  type GraphicsSnapshot
} from './cloud-graphics'
import { parseConsumerCapability } from '../renderer/src/lib/room-media-v2'
const snapshot = () => structuredClone(fixture.snapshot) as GraphicsSnapshot
const page = {
  show: 'sh_graphics',
  publisherSid: 'PA_host',
  output: 'stream' as const,
  orientation: 'h' as const,
  now: 1000
}
describe('S9 static presentation', () => {
  it('requires explicit static capability without certifying alpha or animation', () => {
    const base = {
      v: 2,
      identity: 'EG_one',
      participantSid: 'PA_one',
      graphics: { version: 1, output: 'stream', orientation: 'h' }
    }
    expect(parseConsumerCapability(base)?.graphics?.static).toBeUndefined()
    expect(
      parseConsumerCapability({
        ...base,
        graphics: { ...base.graphics, static: { version: 1, alpha: true, private: 'SECRET' } }
      })?.graphics?.static
    ).toEqual({ version: 1 })
    expect(
      parseConsumerCapability({
        ...base,
        identity: 'g_one',
        graphics: { ...base.graphics, static: { version: 1 } }
      })?.graphics
    ).toMatchObject({ version: 1, output: 'stream', orientation: 'h' })
    // S6 parses the guest avatar lane; the relay and S9 publisher authorize
    // static delivery separately and never grant it to this identity.
    expect(parseStaticCapability({ version: 2 })).toBeNull()
  })
  it('sanitizes public layers and rejects other owner/lane, duplicate, arbitrary URL and malformed assets', () => {
    expect(parseGraphicsSnapshot({ ...snapshot(), private: 'SECRET' }, page)).toEqual(snapshot())
    for (const patch of [
      { publisherSid: 'PA_old' },
      { show: 'other' },
      { output: 'recording' },
      { orientation: 'v' },
      { expiresAt: 31001 },
      { revision: NaN }
    ])
      expect(parseGraphicsSnapshot({ ...snapshot(), ...patch }, page)).toBeNull()
    const duplicate = snapshot()
    duplicate.layers.push(duplicate.layers[0]!)
    expect(parseGraphicsSnapshot(duplicate, page)).toBeNull()
    const bad = snapshot()
    bad.layers[0]!.asset.png = 'https://private/secret'
    expect(parseGraphicsSnapshot(bad, page)).toBeNull()
    expect(graphicsPng({ ...snapshot().layers[0]!.asset, width: 10000 })).toBeNull()
  })
  it('matches native 200ms ease-out cubic, opacity and absolute-time late join', () => {
    const banner = snapshot().layers[0]!
    for (const [at, opacity] of fixture.fade.samples)
      expect(graphicsOpacity(banner, at!)).toBeCloseTo(opacity!, 7)
    expect(
      graphicsOpacity({ ...banner, fade: { at: 1000, from: 1, to: 0 }, expiresAt: 1200 }, 1300)
    ).toBe(0)
  })
  it('clear defeats pending assets, old owner/revision and lease expiry', async () => {
    let finish!: (v: string) => void,
      now = 1000
    const discarded: string[] = [],
      commits: number[] = []
    const receiver = new GraphicsReceiver({
      now: () => now,
      prepare: () =>
        new Promise<string>((r) => {
          finish = r
        }),
      discard: (s: string) => discarded.push(s),
      commit: async (s) => {
        commits.push(s.revision)
      },
      clear: () => {}
    })
    receiver.owner('PA_host')
    const old = receiver.accept({ ...snapshot(), layers: [snapshot().layers[0]!] })
    while (!finish) await new Promise<void>((r) => setImmediate(r))
    expect(await receiver.accept({ ...snapshot(), revision: 2, layers: [] })).toBe(true)
    finish('old')
    expect(await old).toBe(false)
    expect(discarded).toEqual(['old'])
    expect(commits).toEqual([2])
    expect(await receiver.accept(snapshot())).toBe(false)
    now = 31000
    receiver.step()
    expect(receiver.applied).toBeUndefined()
    receiver.owner('PA_new')
    expect(await receiver.accept({ ...snapshot(), revision: 100 })).toBe(false)
  })
  it('coalesces bounded pending decodes to the newest snapshot without a retry delay', async () => {
    let finish!: (value: number) => void
    const commits: number[] = [],
      discarded: number[] = []
    let prepares = 0
    const receiver = new GraphicsReceiver({
      now: () => 1000,
      prepare: async () =>
        ++prepares === 1
          ? new Promise<number>((resolve) => {
              finish = resolve
            })
          : prepares,
      discard: (value: number) => discarded.push(value),
      commit: async (s) => {
        commits.push(s.revision)
      },
      clear: () => {}
    })
    receiver.owner('PA_host')
    const first = receiver.accept(snapshot())
    while (!finish) await new Promise<void>((resolve) => setImmediate(resolve))
    const middle = receiver.accept({ ...snapshot(), revision: 2 })
    const latest = receiver.accept({ ...snapshot(), revision: 3 })
    expect(await middle).toBe(false)
    finish(1)
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    expect(commits).toEqual([3])
    expect(discarded).toEqual([1])
    expect(receiver.applied?.revision).toBe(3)
  })
  it('failed paint clears pixels and cannot acknowledge', async () => {
    let visible = false
    const receiver = new GraphicsReceiver({
      now: () => 1000,
      prepare: async () => 1,
      discard: () => {},
      commit: async () => {
        visible = true
        throw Error('paint')
      },
      clear: () => {
        visible = false
      }
    })
    receiver.owner('PA_host')
    await expect(receiver.accept(snapshot())).rejects.toThrow('paint')
    expect(visible).toBe(false)
    expect(receiver.applied).toBeUndefined()
  })
})
