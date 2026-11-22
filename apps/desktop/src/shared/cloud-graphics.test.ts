import { createHash } from 'node:crypto'
import { afterEach, describe, it, expect, vi } from 'vitest'
import fixture from '../../../../protocol-fixtures/cloud-parity-graphics.json'
import {
  GraphicsReceiver,
  forgetGraphicsSource,
  graphicsOpacity,
  graphicsPngChecked,
  graphicsSourceHeld,
  parseGraphicsSnapshot,
  parseGraphicsSource,
  parseStaticCapability,
  graphicsPng,
  readGraphicsSource,
  sameGraphicsAsset,
  type GraphicsAsset,
  type GraphicsLayer,
  type GraphicsSnapshot
} from './cloud-graphics'
import { base64Bytes } from './cloud-avatar'
import { validateBackendRpcParams, validateBackendRpcResult } from './backend-rpc-contract'
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

// PH-05 and PH-06 (the 11-20 performance hunt). With live captions on in a
// talk show, a caption update is a new graphics snapshot about twice a second.
// Every layer of it (each banner, the chat box, the card) was decoded from
// base64 with a callback per byte, hashed, decoded as an image and rebuilt,
// several times over, although only the caption bar had changed.
const dot = Buffer.from(fixture.snapshot.layers[0]!.asset.png, 'base64')
/**
 * A static PNG of the fixture's size with bytes (and so a hash) of its own:
 * the fixture with a text chunk before its end. `pad` makes it large.
 */
function picture(note: string, pad = 0): GraphicsAsset {
  const text = Buffer.from(`Comment\0${note}${'.'.repeat(pad)}`, 'latin1')
  const chunk = Buffer.alloc(12 + text.length)
  chunk.writeUInt32BE(text.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  text.copy(chunk, 8)
  const bytes = Buffer.concat([
    dot.subarray(0, dot.length - 12),
    chunk,
    dot.subarray(dot.length - 12)
  ])
  return {
    png: bytes.toString('base64'),
    hash: createHash('sha256').update(bytes).digest('hex'),
    width: 1,
    height: 1
  }
}
const layer = (
  id: string,
  kind: GraphicsLayer['kind'],
  asset: GraphicsAsset,
  patch: Partial<GraphicsLayer> = {}
): GraphicsLayer => ({
  id,
  kind,
  rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.15 },
  asset,
  opacity: 1,
  fade: null,
  expiresAt: kind === 'caption' || kind === 'highlight' ? 20_000 : null,
  ...patch
})
const view = (revision: number, layers: GraphicsLayer[]): GraphicsSnapshot => ({
  version: 1,
  show: 'sh_graphics',
  publisherSid: 'PA_host',
  revision,
  output: 'stream',
  orientation: 'h',
  expiresAt: 30_000,
  layers
})
type Base64 = { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }
/** How many base64 strings `run` decodes, by the engine's decoder or by `atob`. */
function decodes(run: () => void): number {
  const loop = vi.spyOn(globalThis, 'atob')
  const native = (Uint8Array as unknown as Base64).fromBase64
    ? vi.spyOn(Uint8Array as unknown as Required<Base64>, 'fromBase64')
    : null
  try {
    run()
    return loop.mock.calls.length + (native?.mock.calls.length ?? 0)
  } finally {
    loop.mockRestore()
    native?.mockRestore()
  }
}
/** A stand-in for the view: what is on screen, and what was asked of it. */
function screen(now: () => number = () => 1000) {
  type Shown = { id: string; hash: string }
  let shown: { asset: Shown; layer: GraphicsLayer }[] = []
  const calls = { prepare: [] as string[], discard: [] as string[], commits: [] as Shown[][] }
  let hold: Promise<void> | null = null
  const receiver = new GraphicsReceiver<Shown>({
    now,
    kept: (l) =>
      shown.find((s) => s.layer.id === l.id && sameGraphicsAsset(s.layer.asset, l.asset))?.asset,
    prepare: async (l, bytes) => {
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(l.asset.hash)
      calls.prepare.push(l.id)
      await hold
      return { id: l.id, hash: l.asset.hash }
    },
    discard: (a) => calls.discard.push(`${a.id}:${a.hash}`),
    commit: async (s, assets) => {
      shown = s.layers.map((l, i) => ({ layer: l, asset: assets[i]! }))
      calls.commits.push(assets)
    },
    clear: () => {
      shown = []
    },
    retain: (ids) => {
      shown = shown.filter((s) => ids.has(s.layer.id))
    }
  })
  receiver.owner('PA_host')
  return {
    receiver,
    calls,
    /** The next prepares wait until the returned function is called. */
    stall() {
      let release!: () => void
      hold = new Promise<void>((resolve) => {
        release = resolve
      })
      return () => {
        hold = null
        release()
      }
    },
    /** The view dropped a layer by itself (its expiry passed). */
    drop(id: string) {
      shown = shown.filter((s) => s.layer.id !== id)
    }
  }
}
/** Until the receiver has asked the view to prepare `count` pictures. Its
 * hash runs on WebCrypto first, so no fixed number of turns is enough on a
 * slow machine (CI saw the next snapshot arrive before the hash was done). */
const prepared = async (s: { calls: { prepare: string[] } }, count: number) => {
  const deadline = Date.now() + 5000
  while (s.calls.prepare.length < count && Date.now() < deadline)
    await new Promise<void>((resolve) => setTimeout(resolve, 1))
  expect(s.calls.prepare).toHaveLength(count)
}

describe('a caption update touches only what changed (PH-05, PH-06)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    forgetGraphicsSource()
  })
  it('decodes base64 to the bytes atob gives, with the engine decoder where there is one', () => {
    const before = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
    const holder = Uint8Array as unknown as Base64
    const native = holder.fromBase64
    try {
      for (const use of [undefined, (text: string) => before(text)]) {
        holder.fromBase64 = use
        for (const bytes of [[], [0], [0, 255], [1, 2, 3], [250, 251, 252, 253], [...dot]]) {
          const text = Buffer.from(bytes).toString('base64')
          expect([...base64Bytes(text)!]).toEqual(bytes)
        }
        expect(base64Bytes(picture('big', 300_000).png)).toEqual(
          before(picture('big', 300_000).png)
        )
      }
      // The engine decoder is the one used, and its refusal is a null.
      const used = vi.fn((text: string) => before(text))
      holder.fromBase64 = used
      base64Bytes('AAAA')
      expect(used).toHaveBeenCalledWith('AAAA')
      holder.fromBase64 = () => {
        throw new SyntaxError('not base64')
      }
      expect(base64Bytes('AAAA')).toBeNull()
      holder.fromBase64 = undefined
      expect(base64Bytes('*')).toBeNull()
    } finally {
      if (native) holder.fromBase64 = native
      else delete holder.fromBase64
    }
  })
  it('checks a picture once: the same one is not decoded again, a different one is', () => {
    const banner = picture('checked once', 4000)
    expect(decodes(() => expect(graphicsPngChecked(banner)).toBe(true))).toBe(1)
    // The same picture in a new object, with an equal but separate string.
    const again = { ...banner, png: Buffer.from(banner.png).toString() }
    expect(
      decodes(() => {
        for (let i = 0; i < 50; i++) expect(graphicsPngChecked(again)).toBe(true)
      })
    ).toBe(0)
    // Other pixels under the same hash, or another size, are checked in full.
    const other = picture('checked twice', 4000)
    expect(decodes(() => graphicsPngChecked({ ...banner, png: other.png }))).toBe(1)
    expect(graphicsPngChecked({ ...banner, width: 2 })).toBe(false)
    expect(graphicsPngChecked({ ...banner, png: 'https://private/secret' })).toBe(false)
    // A refusal is never remembered as a pass.
    const apng = Buffer.from(banner.png, 'base64')
    apng.write('acTL', apng.indexOf('tEXt'), 'latin1')
    const animated = { ...banner, hash: 'f'.repeat(64), png: apng.toString('base64') }
    expect(graphicsPng(animated)).toBeNull()
    expect(graphicsPngChecked(animated)).toBe(false)
    expect(graphicsPngChecked(animated)).toBe(false)
    // The memory is bounded: after forty other pictures this one is checked again.
    expect(graphicsPngChecked(banner)).toBe(true)
    expect(decodes(() => graphicsPngChecked(banner))).toBe(0)
    for (let i = 0; i < 40; i++) expect(graphicsPngChecked(picture(`flood ${i}`))).toBe(true)
    expect(decodes(() => expect(graphicsPngChecked(banner)).toBe(true))).toBe(1)
  })
  it('a parsed snapshot decodes a layer once however often it is sent', () => {
    const banner = layer('banner:a', 'banner', picture('parsed banner', 2000))
    const page = { ...view(1, []), now: 1000 }
    const caption = (n: number) => layer('caption', 'caption', picture(`parsed caption ${n}`))
    expect(
      decodes(() => expect(parseGraphicsSnapshot(view(1, [banner, caption(0)]), page)).toBeTruthy())
    ).toBe(2)
    // Sixty caption updates: the banner is never decoded again.
    expect(
      decodes(() => {
        for (let n = 1; n <= 60; n++)
          expect(
            parseGraphicsSnapshot(structuredClone(view(n + 1, [banner, caption(n)])), page)
          ).toBeTruthy()
      })
    ).toBe(60)
  })
  it('one changed layer among four prepares one picture and keeps the other three', async () => {
    const s = screen()
    const banner = layer('banner:a', 'banner', picture('keep banner a'))
    const second = layer('banner:b', 'banner', picture('keep banner b'))
    const chat = layer('chat', 'chat', picture('keep chat'))
    const caption = (n: number) => layer('caption', 'caption', picture(`keep caption ${n}`))
    expect(await s.receiver.accept(view(1, [banner, second, caption(1), chat]))).toBe(true)
    expect(s.calls.prepare).toEqual(['banner:a', 'banner:b', 'caption', 'chat'])
    const first = s.calls.commits[0]!
    for (let n = 2; n <= 10; n++)
      expect(await s.receiver.accept(view(n, [banner, second, caption(n), chat]))).toBe(true)
    // Nine caption updates: nine prepares, all of them the caption.
    expect(s.calls.prepare.slice(4)).toEqual(Array(9).fill('caption'))
    const last = s.calls.commits.at(-1)!
    expect(last[0]).toBe(first[0])
    expect(last[1]).toBe(first[1])
    expect(last[3]).toBe(first[3])
    expect(last[2]).not.toBe(first[2])
    // What the receiver kept is the view's: it discarded nothing.
    expect(s.calls.discard).toEqual([])
    expect(s.receiver.applied).toEqual({ publisherSid: 'PA_host', revision: 10 })
    // A layer that only moves is kept too.
    const moved = { ...second, rect: { x: 0.5, y: 0.5, w: 0.3, h: 0.15 } }
    expect(await s.receiver.accept(view(11, [banner, moved, caption(10), chat]))).toBe(true)
    expect(s.calls.prepare).toHaveLength(13)
    expect(s.calls.commits.at(-1)![1]).toBe(first[1])
    // The same picture under another id is not the layer on screen.
    const renamed = { ...chat, id: 'banner:c', kind: 'banner' as const }
    expect(await s.receiver.accept(view(12, [banner, moved, renamed, caption(10)]))).toBe(true)
    expect(s.calls.prepare.at(-1)).toBe('banner:c')
    expect(s.calls.prepare).toHaveLength(14)
  })
  it('other pixels under a hash on screen are hashed, refused and cleared as before', async () => {
    const s = screen()
    const banner = layer('banner:a', 'banner', picture('strict banner'))
    expect(await s.receiver.accept(view(1, [banner]))).toBe(true)
    const forged = { ...banner, asset: { ...banner.asset, png: picture('strict forgery').png } }
    await expect(s.receiver.accept(view(2, [forged]))).rejects.toThrow('Graphic hash mismatch')
    expect(s.receiver.applied).toBeUndefined()
    expect(s.calls.prepare).toEqual(['banner:a'])
    // Cleared: the banner is prepared again.
    expect(await s.receiver.accept(view(3, [banner]))).toBe(true)
    expect(s.calls.prepare).toEqual(['banner:a', 'banner:a'])
  })
  it('a superseded apply discards only what it prepared, never a kept picture', async () => {
    const s = screen()
    const banner = layer('banner:a', 'banner', picture('fence banner'))
    const caption = (n: number) => layer('caption', 'caption', picture(`fence caption ${n}`))
    expect(await s.receiver.accept(view(1, [banner, caption(1)]))).toBe(true)
    const release = s.stall()
    const second = s.receiver.accept(view(2, [banner, caption(2)]))
    await prepared(s, 3)
    const third = s.receiver.accept(view(3, [banner, caption(3)]))
    release()
    expect(await second).toBe(false)
    expect(await third).toBe(true)
    expect(s.calls.discard).toEqual([`caption:${caption(2).asset.hash}`])
    expect(s.calls.commits).toHaveLength(2)
    expect(s.calls.commits[1]![0]).toBe(s.calls.commits[0]![0])
    // A clear while one decodes: the same rule.
    const again = s.stall()
    const fourth = s.receiver.accept(view(4, [banner, caption(4)]))
    await prepared(s, 5)
    expect(await s.receiver.accept(view(5, []))).toBe(true)
    again()
    expect(await fourth).toBe(false)
    expect(s.calls.discard).toEqual([
      `caption:${caption(2).asset.hash}`,
      `caption:${caption(4).asset.hash}`
    ])
  })
  it('a picture the view dropped while another decoded is prepared after all', async () => {
    const s = screen()
    const banner = layer('banner:a', 'banner', picture('drop banner'))
    const card = layer('highlight', 'highlight', picture('drop card'))
    const caption = (n: number) => layer('caption', 'caption', picture(`drop caption ${n}`))
    expect(await s.receiver.accept(view(1, [banner, caption(1), card]))).toBe(true)
    const release = s.stall()
    const next = s.receiver.accept(view(2, [banner, caption(2), card]))
    await prepared(s, 4)
    s.drop('highlight')
    release()
    expect(await next).toBe(true)
    expect(s.calls.prepare.slice(3)).toEqual(['caption', 'highlight'])
    expect(s.calls.commits[1]![0]).toBe(s.calls.commits[0]![0])
    expect(s.calls.commits[1]![2]).not.toBe(s.calls.commits[0]![2])
    expect(s.calls.discard).toEqual([])
  })
  it('an answer by reference is completed from the last answers, and refused when it cannot be', () => {
    const now = Date.now()
    const placed = (l: GraphicsLayer) => ({ ...l, stream: true, recording: false })
    const banner = placed(layer('banner:a', 'banner', picture('source banner', 3000)))
    const caption = (n: number) =>
      placed(layer('caption', 'caption', picture(`source caption ${n}`), { expiresAt: now + 5000 }))
    const reference = <L extends { asset: GraphicsAsset }>(l: L) => ({
      ...l,
      asset: { hash: l.asset.hash, width: l.asset.width, height: l.asset.height }
    })
    const answer = (n: number, h: unknown[], v: unknown[] = []) => ({
      signature: n.toString(16).padStart(64, '0'),
      content: { h, v, unsupported: [] }
    })
    expect(graphicsSourceHeld()).toEqual([])
    // Nothing held: a reference is refused, and so is one read without a holder.
    expect(readGraphicsSource(answer(1, [reference(banner), caption(1)]))).toBeNull()
    const first = readGraphicsSource(answer(1, [banner, caption(1)], [banner]))!
    expect(first.content!.h.map((l) => l.id)).toEqual(['banner:a', 'caption'])
    expect(graphicsSourceHeld().sort()).toEqual([banner.asset.hash, caption(1).asset.hash].sort())
    expect(parseGraphicsSource(answer(2, [reference(banner), caption(2)]))).toBeNull()
    // A caption update: the banner by reference, both orientations. Only the
    // caption is decoded, and the banner's base64 is the string already held.
    let second!: NonNullable<ReturnType<typeof readGraphicsSource>>
    expect(
      decodes(() => {
        second = readGraphicsSource(
          answer(2, [reference(banner), caption(2)], [reference(banner)])
        )!
      })
    ).toBe(1)
    expect(second.content!.h[0]!.asset).toEqual(banner.asset)
    expect(second.content!.h[0]!.asset.png).toBe(first.content!.h[0]!.asset.png)
    expect(second.content!.v[0]!.asset.png).toBe(first.content!.h[0]!.asset.png)
    expect(second.content!.h[0]).toMatchObject({ stream: true, recording: false })
    expect(graphicsSourceHeld().sort()).toEqual([banner.asset.hash, caption(2).asset.hash].sort())
    // An unchanged answer keeps what is held.
    expect(readGraphicsSource({ signature: 'a'.repeat(64), content: null })).toEqual({
      signature: 'a'.repeat(64),
      content: null
    })
    expect(graphicsSourceHeld()).toHaveLength(2)
    // The answer before the last still completes one (a poll read late).
    expect(readGraphicsSource(answer(3, [reference(banner), reference(caption(1))]))).toBeTruthy()
    expect(readGraphicsSource(answer(4, [reference(banner), reference(caption(2))]))).toBeTruthy()
    expect(readGraphicsSource(answer(5, [reference(banner), reference(caption(2))]))).toBeTruthy()
    expect(readGraphicsSource(answer(6, [reference(banner), reference(caption(1))]))).toBeNull()
    // Same hash, another size: refused. An unreadable answer changes nothing.
    const resized = { ...banner, asset: { hash: banner.asset.hash, width: 2, height: 1 } }
    expect(readGraphicsSource(answer(7, [resized]))).toBeNull()
    expect(graphicsSourceHeld()).toHaveLength(2)
    forgetGraphicsSource()
    expect(graphicsSourceHeld()).toEqual([])
    expect(readGraphicsSource(answer(8, [reference(banner)]))).toBeNull()
    expect(readGraphicsSource(answer(8, [banner]))).toBeTruthy()
  })
  it('the poll names what it holds: the contract bounds the list and completes the answer', () => {
    const banner = {
      ...layer('banner:a', 'banner', picture('contract banner')),
      stream: true,
      recording: true
    }
    const { hash, width, height } = banner.asset
    const params = (held: unknown) =>
      validateBackendRpcParams('cloud.graphics.snapshot', { showId: 'sh_graphics', held })
    expect(params([hash])).toMatchObject({ showId: 'sh_graphics', held: [hash] })
    expect(
      validateBackendRpcParams('cloud.graphics.snapshot', { showId: 'sh_graphics' })
    ).toMatchObject({ showId: 'sh_graphics' })
    for (const held of [[hash.slice(1)], [`${hash}0`], Array(33).fill(hash), hash, [1]])
      expect(() => params(held)).toThrow()
    const answer = (asset: unknown) => ({
      signature: 'b'.repeat(64),
      content: { h: [{ ...banner, asset }], v: [], unsupported: [] }
    })
    const read = (asset: unknown) =>
      validateBackendRpcResult('cloud.graphics.snapshot', answer(asset)) as ReturnType<
        typeof readGraphicsSource
      >
    expect(() => read({ hash, width, height })).toThrow()
    expect(read(banner.asset)?.content?.h[0]?.asset).toEqual(banner.asset)
    expect(read({ hash, width, height })?.content?.h[0]?.asset).toEqual(banner.asset)
  })
})
