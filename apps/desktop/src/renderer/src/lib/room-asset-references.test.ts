import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionState, RoomEvent, type Room } from 'livekit-client'
import { RoomGraphicsPublisher, type AcceptedGraphicsView } from './room-graphics-publisher'
import { RoomAvatarPublisher, type AcceptedAvatarView } from './room-avatar-publisher'
import { CAPABILITY_TOPIC, parseConsumerCapability } from './room-media-v2'
import { SentAssets, withReferences } from './room-asset-references'
import {
  GraphicsReceiver,
  parseGraphicsSnapshot,
  type GraphicsSnapshot
} from '../../../shared/cloud-graphics'
import {
  AvatarReceiver,
  parseAvatarSnapshot,
  type AvatarSnapshot
} from '../../../shared/cloud-avatar'
import graphicsFixture from '../../../../../../protocol-fixtures/cloud-parity-graphics.json'

/** A real 256x256 PNG (the audit's fixture) and the 1x1 protocol fixture. */
const logo = (() => {
  const png = readFileSync(new URL('../assets/videorc-logo.png', import.meta.url))
  return {
    png: png.toString('base64'),
    hash: createHash('sha256').update(png).digest('hex'),
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20)
  }
})()
const dot = graphicsFixture.snapshot.layers[0]!.asset

type Kind = 'graphics' | 'avatar'
type Upload = { at: number; target: string; bytes: number; raw: Record<string, unknown> }
type Receiver = (GraphicsReceiver<object> | AvatarReceiver<object>) & {
  asset(hash: string): { png: string } | undefined
}

/**
 * The real publisher, and per consumer a real receiver behind the program
 * page's parse: what it applied is what that consumer's receipt acknowledges.
 */
function harness(kind: Kind, consumers = 1, opts: { refs?: boolean } = {}) {
  const refs = opts.refs ?? true
  const uploads: Upload[] = []
  const accepted: (AcceptedGraphicsView | AcceptedAvatarView)[] = []
  const peers = Array.from({ length: consumers }, (_, i) => ({
    identity: `EG_program${i}`,
    sid: `PA_program${i}`
  }))
  const counts = new Map<string, { prepares: number; commits: number; renews: number }>()
  const receivers = new Map<string, Receiver>()
  const applied = new Map<string, { publisherSid: string; revision: number } | undefined>()
  const makeReceiver = (identity: string): Receiver => {
    const count = { prepares: 0, commits: 0, renews: 0 }
    counts.set(identity, count)
    const deps = {
      now: () => Date.now(),
      prepare: async () => {
        count.prepares++
        return {}
      },
      discard: () => {},
      clear: () => {},
      commit: async () => {
        count.commits++
      },
      renew: () => {
        count.renews++
      }
    }
    const receiver = (
      kind === 'graphics' ? new GraphicsReceiver(deps) : new AvatarReceiver(deps)
    ) as Receiver
    receiver.owner('PA_host')
    return receiver
  }
  for (const p of peers) receivers.set(p.identity, makeReceiver(p.identity))
  let rejected = 0
  /** Deliveries in flight: the receiver hashes on real time, the clock is fake. */
  const inflight = new Set<Promise<unknown>>()
  const track = <T>(job: Promise<T>): Promise<T> => {
    inflight.add(job)
    void job.finally(() => inflight.delete(job)).catch(() => {})
    return job
  }
  const settle = async () => {
    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(0)
      if (!inflight.size) return
      await Promise.allSettled([...inflight])
    }
  }
  const room = Object.assign(new EventEmitter(), {
    state: ConnectionState.Connected,
    name: 'sh_refs',
    remoteParticipants: new Map(peers.map((p) => [p.identity, { ...p }])),
    localParticipant: {
      sid: 'PA_host',
      streamBytes: vi.fn(async (options: { destinationIdentities: string[] }) => {
        const chunks: Buffer[] = []
        const deliver = async () => {
          const body = Buffer.concat(chunks)
          const target = options.destinationIdentities[0]!
          const raw = JSON.parse(body.toString()) as Record<string, unknown>
          uploads.push({ at: Date.now(), target, bytes: body.length, raw })
          const receiver = receivers.get(target)!
          const page = {
            show: 'sh_refs',
            publisherSid: 'PA_host',
            output: 'stream' as const,
            orientation: 'h' as const,
            now: Date.now(),
            resolve: (hash: string) => receiver.asset(hash) as never
          }
          const parsed =
            kind === 'graphics' ? parseGraphicsSnapshot(raw, page) : parseAvatarSnapshot(raw, page)
          if (!parsed) {
            rejected++
            return
          }
          await (receiver.accept as (s: GraphicsSnapshot | AvatarSnapshot) => Promise<boolean>)(
            parsed
          )
        }
        return {
          write: async (bytes: Uint8Array) => {
            chunks.push(Buffer.from(bytes))
          },
          // The page applies before the write resolves; `settle` waits for it.
          close: () => track(deliver())
        }
      })
    }
  })
  const onAccepted = (view: AcceptedGraphicsView | AcceptedAvatarView) => accepted.push(view)
  const publisher =
    kind === 'graphics'
      ? new RoomGraphicsPublisher(room as unknown as Room, () => {}, onAccepted)
      : new RoomAvatarPublisher(room as unknown as Room, () => {}, onAccepted)
  const content = (asset: typeof logo, rect = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }) =>
    kind === 'graphics'
      ? {
          h: [
            {
              id: 'banner:logo',
              kind: 'banner' as const,
              rect,
              asset,
              opacity: 1,
              fade: null,
              expiresAt: null,
              stream: true,
              recording: false
            }
          ],
          v: [],
          unsupported: []
        }
      : {
          h: [{ kind: 'avatar' as const, rect, asset, expiresAt: null }],
          v: [],
          stream: true,
          recording: false
        }
  const set = (asset: typeof logo | null, rect?: { x: number; y: number; w: number; h: number }) =>
    (publisher.set as (c: unknown) => void)(asset ? content(asset, rect) : null)
  /** Each consumer's receipt, acknowledging what its receiver applied. */
  const receipt = (overrides: { ack?: Record<string, unknown> } = {}) => {
    for (const peer of peers) {
      const sid = room.remoteParticipants.get(peer.identity)?.sid ?? peer.sid
      const ack =
        overrides.ack ?? applied.get(peer.identity) ?? receivers.get(peer.identity)!.applied
      const graphics =
        kind === 'graphics'
          ? {
              version: 1,
              output: 'stream',
              orientation: 'h',
              static: { version: 1, ...(refs ? { refs: 1 } : {}), ...(ack ? { applied: ack } : {}) }
            }
          : {
              version: 1,
              output: 'stream',
              orientation: 'h',
              ...(refs ? { refs: 1 } : {}),
              ...(ack ? { applied: ack } : {})
            }
      room.emit(
        RoomEvent.DataReceived,
        new TextEncoder().encode(
          JSON.stringify({
            v: 2,
            identity: peer.identity,
            participantSid: sid,
            at: Date.now(),
            graphics
          })
        ),
        undefined,
        undefined,
        CAPABILITY_TOPIC
      )
    }
  }
  /** Seconds of fake time with a receipt every 5 s; counts seconds a consumer showed nothing. */
  const run = async (seconds: number) => {
    let dark = 0
    for (let i = 1; i <= seconds; i++) {
      await vi.advanceTimersByTimeAsync(1000)
      await settle()
      for (const r of receivers.values()) r.step()
      if (Date.now() > 3000 && !receivers.get(peers[0]!.identity)!.applied) dark++
      if (Math.floor(Date.now() / 1000) % 5 === 0) {
        receipt()
        await settle()
      }
    }
    return dark
  }
  const isRef = (u: Upload) =>
    ((u.raw.layers as { asset: Record<string, unknown> }[]) ?? []).some(
      (l) => l.asset.png === undefined
    )
  return {
    room,
    publisher,
    peers,
    receivers,
    counts,
    uploads,
    accepted,
    applied,
    set,
    receipt,
    run,
    isRef,
    rejected: () => rejected,
    replaceReceiver: (identity: string) => receivers.set(identity, makeReceiver(identity))
  }
}

// The 120 s simulations do real SHA-256 per delivery; a loaded Mac needs room.
vi.setConfig({ testTimeout: 60_000 })
afterEach(() => vi.useRealTimers())

describe.each(['graphics', 'avatar'] as const)('%s lease renewals (PERF-06)', (kind) => {
  it.each([1, 4])(
    'sends the picture once per consumer session over 120 s with %i consumer(s), renewals keep flowing',
    async (consumers) => {
      vi.useFakeTimers()
      vi.setSystemTime(1000)
      const h = harness(kind, consumers)
      h.set(logo)
      h.receipt()
      const dark = await h.run(120)
      for (const peer of h.peers) {
        const mine = h.uploads.filter((u) => u.target === peer.identity)
        // Renewals continue on the 10 s cadence: no lease gap.
        expect(mine.length).toBeGreaterThanOrEqual(11)
        expect(mine.filter((u) => !h.isRef(u))).toHaveLength(1)
        expect(mine.slice(1).every((u) => h.isRef(u) && u.bytes < 1024)).toBe(true)
        expect(h.counts.get(peer.identity)).toMatchObject({ prepares: 1, commits: 1 })
        expect(h.receivers.get(peer.identity)!.applied?.revision).toBe(
          (mine.at(-1)!.raw as { revision: number }).revision
        )
      }
      expect(dark).toBe(0)
      expect(h.rejected()).toBe(0)
      // S24 keeps the full pixels for the cloud, never the reference.
      expect(h.accepted.length).toBeGreaterThan(0)
      for (const view of h.accepted)
        for (const layer of view.layers) expect(layer.asset.png).toBe(logo.png)
      h.publisher.close()
    }
  )

  it('an older page without refs gets every renewal whole; its receiver still skips re-decoding', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness(kind, 1, { refs: false })
    h.set(logo)
    h.receipt()
    await h.run(60)
    expect(h.uploads.length).toBeGreaterThanOrEqual(5)
    expect(h.uploads.some((u) => h.isRef(u))).toBe(false)
    expect(h.counts.get('EG_program0')).toMatchObject({ prepares: 1, commits: 1 })
    h.publisher.close()
  })

  it('a new picture, Hide and a new consumer session go whole; a moved layer keeps its reference', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness(kind)
    h.set(logo)
    h.receipt()
    await h.run(30)
    expect(h.uploads.at(-1) && h.isRef(h.uploads.at(-1)!)).toBe(true)
    // New picture: its bytes go out (the old hash was never held for it).
    h.set(dot)
    await h.run(2)
    const changed = h.uploads.at(-1)!
    expect(h.isRef(changed)).toBe(false)
    expect(JSON.stringify(changed.raw)).toContain(dot.png)
    await h.run(25)
    expect(h.isRef(h.uploads.at(-1)!)).toBe(true)
    // Moved layer, same picture: a content change that still refers to the
    // held bytes; the page lays it out again (one prepare), nothing resent.
    const prepares = h.counts.get('EG_program0')!.prepares
    h.set(dot, { x: 0.5, y: 0.5, w: 0.2, h: 0.2 })
    await h.run(2)
    const moved = h.uploads.at(-1)!
    expect(h.isRef(moved)).toBe(true)
    expect(JSON.stringify(moved.raw)).toContain('0.5')
    await h.run(25)
    expect(h.counts.get('EG_program0')!.prepares).toBe(prepares + 1)
    expect(h.rejected()).toBe(0)
    // Hide, then show again: the set() resets what was sent, so the picture goes whole.
    h.set(null)
    await h.run(2)
    h.set(dot)
    await h.run(2)
    expect(h.isRef(h.uploads.at(-1)!)).toBe(false)
    await h.run(20)
    // Reconnect: the page comes back as a new session with a fresh receiver.
    const before = h.uploads.length
    h.room.remoteParticipants.set('EG_program0', { identity: 'EG_program0', sid: 'PA_program0b' })
    h.replaceReceiver('EG_program0')
    h.receipt()
    await h.run(12)
    const fresh = h.uploads.slice(before).filter((u) => u.target === 'EG_program0')
    expect(fresh.length).toBeGreaterThan(0)
    expect(h.isRef(fresh[0]!)).toBe(false)
    expect(h.rejected()).toBe(0)
    expect(h.receivers.get('EG_program0')!.applied).toBeDefined()
    h.publisher.close()
  })

  it('a page that lost the picture refuses the reference and the next renewal goes whole', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness(kind)
    h.set(logo)
    h.receipt()
    await h.run(20)
    // The page clears (say, an error) right after acknowledging; the receipt
    // still names the old revision, so the publisher may send a reference.
    const stale = h.receivers.get('EG_program0')!.applied!
    h.receivers.get('EG_program0')!.clear()
    h.applied.set('EG_program0', stale)
    await h.run(12)
    expect(h.rejected()).toBeGreaterThan(0)
    h.applied.delete('EG_program0')
    await h.run(15)
    const last = h.uploads.filter((u) => !h.isRef(u)).at(-1)!
    expect(last.at).toBeGreaterThan(21_000)
    expect(h.receivers.get('EG_program0')!.applied).toBeDefined()
    h.publisher.close()
  })

  it('a takeover (another publisher acknowledged) gets the picture whole', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const h = harness(kind)
    h.set(logo)
    h.receipt()
    await h.run(15)
    h.applied.set('EG_program0', { publisherSid: 'PA_other', revision: 99 })
    const before = h.uploads.length
    await h.run(15)
    const after = h.uploads.slice(before)
    expect(after.length).toBeGreaterThan(0)
    expect(after.some((u) => h.isRef(u))).toBe(false)
    h.publisher.close()
  })
})

describe('reference resolution and the renewal fast path', () => {
  const page = {
    show: 'sh_graphics',
    publisherSid: 'PA_host',
    output: 'stream' as const,
    orientation: 'h' as const,
    now: 1000
  }
  const full = () => structuredClone(graphicsFixture.snapshot) as GraphicsSnapshot
  it('resolves a held reference to the same bytes and refuses one it cannot', () => {
    const snapshot = full()
    const held = new Set([dot.hash])
    const wire = JSON.parse(JSON.stringify(withReferences(snapshot, held)))
    expect(JSON.stringify(wire)).not.toContain(dot.png)
    expect(parseGraphicsSnapshot(wire, { ...page, resolve: () => dot })).toEqual(snapshot)
    expect(parseGraphicsSnapshot(wire, page)).toBeNull()
    expect(parseGraphicsSnapshot(wire, { ...page, resolve: () => undefined })).toBeNull()
    expect(
      parseGraphicsSnapshot(wire, { ...page, resolve: () => ({ ...dot, width: 2 }) })
    ).toBeNull()
    // A wrong held picture fails the receiver's hash check, never shows.
    expect(
      parseGraphicsSnapshot(wire, { ...page, resolve: () => ({ ...logo, width: 1, height: 1 }) })
    ).toBeNull()
  })
  it('only references hashes the acknowledged snapshot and every later one share, same session', () => {
    const layers = (...hashes: string[]) => hashes.map((hash) => ({ asset: { hash } }))
    const assets = new SentAssets()
    assets.record('EG', 'PA_p', 'PA_host', {
      revision: 4,
      expiresAt: 50_000,
      layers: layers('a', 'b')
    })
    assets.record('EG', 'PA_p', 'PA_host', {
      revision: 5,
      expiresAt: 60_000,
      layers: layers('a', 'c')
    })
    const ack = { publisherSid: 'PA_host', revision: 4 }
    const held = (
      applied: typeof ack | undefined,
      sid = 'PA_p',
      refs = true,
      local = 'PA_host',
      now = 1000
    ) => [...assets.held('EG', { refs, applied, sid }, local, now)].sort()
    // Acknowledged 4, 5 written since: the page holds 4's or 5's pictures, so only `a`.
    expect(held(ack)).toEqual(['a'])
    expect(held({ ...ack, revision: 5 })).toEqual(['a', 'c'])
    expect(held(ack, 'PA_p', false)).toEqual([])
    expect(held(undefined)).toEqual([])
    expect(held({ ...ack, revision: 3 })).toEqual([])
    expect(held({ ...ack, publisherSid: 'PA_x' })).toEqual([])
    expect(held(ack, 'PA_q')).toEqual([])
    expect(held(ack, 'PA_p', true, 'PA_new_host')).toEqual([])
    expect(held(ack, 'PA_p', true, 'PA_host', 50_000)).toEqual([])
    // Hide (an empty snapshot) written after: nothing is held any more.
    assets.record('EG', 'PA_p', 'PA_host', { revision: 6, expiresAt: 60_000, layers: [] })
    expect(held({ ...ack, revision: 5 })).toEqual([])
    // A new session starts over; history is bounded.
    assets.record('EG', 'PA_p2', 'PA_host', { revision: 7, expiresAt: 60_000, layers: layers('a') })
    expect(held({ ...ack, revision: 5 }, 'PA_p2')).toEqual([])
    for (let r = 8; r < 20; r++)
      assets.record('EG', 'PA_p2', 'PA_host', {
        revision: r,
        expiresAt: 60_000,
        layers: layers('a')
      })
    expect(held({ ...ack, revision: 7 }, 'PA_p2')).toEqual([])
    expect(held({ ...ack, revision: 19 }, 'PA_p2')).toEqual(['a'])
    assets.forget('EG')
    expect(held({ ...ack, revision: 19 }, 'PA_p2')).toEqual([])
  })
  it('a reference still resolves while a newer change is being laid out', async () => {
    let release!: () => void
    let block = false
    const receiver = new GraphicsReceiver({
      now: () => 1000,
      prepare: () =>
        block ? new Promise<object>((r) => (release = () => r({}))) : Promise.resolve({}),
      discard: () => {},
      clear: () => {},
      commit: async () => {},
      renew: () => {}
    })
    receiver.owner('PA_host')
    expect(await receiver.accept(full())).toBe(true)
    // A moved banner (same picture) starts a full apply that stalls in decode.
    block = true
    const moved = { ...full(), revision: 2 }
    moved.layers[0]!.rect = { x: 0.2, y: 0.1, w: 0.3, h: 0.15 }
    const applying = receiver.accept(moved)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(receiver.applied).toBeUndefined()
    // The next change, by reference: the committed pictures still answer.
    const next = { ...full(), revision: 3 }
    const wire = JSON.parse(JSON.stringify(withReferences(next, new Set([dot.hash]))))
    expect(parseGraphicsSnapshot(wire, { ...page, resolve: (h) => receiver.asset(h) })).toEqual(
      next
    )
    release()
    block = false
    await applying
    receiver.clear()
    expect(receiver.asset(dot.hash)).toBeUndefined()
  })
  it('a renewal moves expiries without decoding; the lease still lapses without renewals', async () => {
    let now = 1000
    const calls = { prepare: 0, commit: 0, renew: [] as GraphicsSnapshot[] }
    const receiver = new GraphicsReceiver({
      now: () => now,
      prepare: async () => {
        calls.prepare++
        return {}
      },
      discard: () => {},
      clear: () => {},
      commit: async () => {
        calls.commit++
      },
      renew: (s) => calls.renew.push(s)
    })
    receiver.owner('PA_host')
    const first = full()
    expect(await receiver.accept(first)).toBe(true)
    now = 9000
    const renewal = { ...full(), revision: 2, expiresAt: 38_000 }
    renewal.layers[2]!.expiresAt = 20_000
    expect(await receiver.accept(renewal)).toBe(true)
    expect(calls).toMatchObject({ prepare: 3, commit: 1 })
    expect(calls.renew).toEqual([renewal])
    expect(receiver.applied).toEqual({ publisherSid: 'PA_host', revision: 2 })
    // The highlight layer's own expiry passed: the next one takes the full path.
    now = 21_000
    const later = { ...full(), revision: 3, expiresAt: 45_000 }
    later.layers[2]!.expiresAt = 30_000
    expect(await receiver.accept(later)).toBe(true)
    expect(calls).toMatchObject({ prepare: 6, commit: 2 })
    // Different placement: full path.
    const moved = { ...full(), revision: 4, expiresAt: 45_000 }
    moved.layers[2]!.expiresAt = 30_000
    moved.layers[0]!.rect = { x: 0.2, y: 0.1, w: 0.3, h: 0.15 }
    expect(await receiver.accept(moved)).toBe(true)
    expect(calls.commit).toBe(3)
    // No renewal: the lease lapses and the held pictures go with it.
    now = 45_000
    receiver.step()
    expect(receiver.applied).toBeUndefined()
    expect(receiver.asset(dot.hash)).toBeUndefined()
  })
  it('an owner change drops the held pictures', async () => {
    const receiver = new AvatarReceiver({
      now: () => 1000,
      prepare: async () => ({}),
      discard: () => {},
      clear: () => {},
      commit: async () => {},
      renew: () => {}
    })
    receiver.owner('PA_host')
    const avatar = {
      version: 1 as const,
      show: 'sh',
      publisherSid: 'PA_host',
      revision: 1,
      output: 'stream' as const,
      orientation: 'h' as const,
      expiresAt: 20_000,
      layers: [
        {
          kind: 'avatar' as const,
          rect: { x: 0, y: 0, w: 0.5, h: 0.5 },
          asset: dot,
          expiresAt: null
        }
      ]
    }
    expect(await receiver.accept(avatar)).toBe(true)
    expect(receiver.asset(dot.hash)?.png).toBe(dot.png)
    receiver.owner('PA_other')
    expect(receiver.asset(dot.hash)).toBeUndefined()
  })
  it('parses the refs capability for static graphics and avatars, nothing else', () => {
    const base = {
      v: 2,
      identity: 'EG_one',
      participantSid: 'PA_one',
      graphics: { version: 1, output: 'stream', orientation: 'h' }
    }
    const parsed = parseConsumerCapability({
      ...base,
      graphics: { ...base.graphics, refs: 1, static: { version: 1, captions: 1, refs: 1 } }
    })
    expect(parsed?.graphics).toMatchObject({
      refs: 1,
      static: { version: 1, captions: 1, refs: 1 }
    })
    expect(
      parseConsumerCapability({ ...base, graphics: { ...base.graphics, refs: 2 } })?.graphics
    ).toBeUndefined()
    expect(parseConsumerCapability(base)?.graphics?.refs).toBeUndefined()
  })
})
