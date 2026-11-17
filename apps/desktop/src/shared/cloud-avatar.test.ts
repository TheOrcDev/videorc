import { describe, expect, it } from 'vitest'
import {
  AvatarReceiver,
  avatarHash,
  avatarPng,
  parseAvatarCapability,
  parseAvatarSnapshot,
  type AvatarSnapshot
} from './cloud-avatar'
import { parseConsumerCapability } from '../renderer/src/lib/room-media-v2'
import fixture from '../../../../protocol-fixtures/cloud-parity-avatar.json'

const page = {
  show: 'sh_avatar',
  publisherSid: 'PA_host',
  output: 'stream' as const,
  orientation: 'h' as const,
  now: 1000
}
const snapshot = () => structuredClone(fixture.snapshot) as AvatarSnapshot

describe('S4 public presentation contract', () => {
  it('sanitizes public state and keeps the graphics capability independent of media v2', () => {
    const value = parseAvatarSnapshot(
      { ...snapshot(), persona: { personality: 'PRIVATE' }, prompt: 'PRIVATE' },
      page
    )!
    expect(JSON.stringify(value)).not.toContain('PRIVATE')
    expect(value.layers.map((l) => l.kind)).toEqual(['avatar', 'bubble'])
    expect(
      parseConsumerCapability({ v: 2, identity: 'EG_test', participantSid: 'PA_consumer' })
        ?.graphics
    ).toBeUndefined()
    expect(
      parseAvatarCapability({ version: 1, output: 'stream', orientation: 'h', private: 'PRIVATE' })
    ).toEqual({ version: 1, output: 'stream', orientation: 'h' })
    // Plan 249 S6 (D4): a guest only on the guest lane (stream, landscape).
    expect(
      parseConsumerCapability({
        v: 2,
        identity: 'g_test',
        participantSid: 'PA_guest',
        graphics: { version: 1, output: 'stream', orientation: 'h' }
      })?.graphics
    ).toEqual({ version: 1, output: 'stream', orientation: 'h' })
    for (const lane of [
      { output: 'recording', orientation: 'h' },
      { output: 'stream', orientation: 'v' }
    ])
      expect(
        parseConsumerCapability({
          v: 2,
          identity: 'g_test',
          participantSid: 'PA_guest',
          graphics: { version: 1, ...lane }
        })
      ).toBeNull()
  })
  it('rejects wrong owner/show/output, unknown versions, unbounded assets and malformed timestamps', () => {
    for (const patch of [
      { show: 'other' },
      { publisherSid: 'PA_old' },
      { output: 'recording' },
      { orientation: 'v' },
      { version: 2 },
      { revision: NaN },
      { expiresAt: 999 },
      { expiresAt: 31001 }
    ])
      expect(parseAvatarSnapshot({ ...snapshot(), ...patch }, page)).toBeNull()
    const bad = snapshot()
    bad.layers[0]!.asset.width = 100000
    expect(parseAvatarSnapshot(bad, page)).toBeNull()
    expect(avatarPng('data:image/png;base64,not-an-asset', 1, 1)).toBeNull()
    const duplicate = snapshot()
    duplicate.layers.push(duplicate.layers[0]!)
    expect(parseAvatarSnapshot(duplicate, page)).toBeNull()
    const forever = snapshot()
    forever.layers[1]!.expiresAt = null
    expect(parseAvatarSnapshot(forever, page)).toBeNull()
  })
  it('checks the immutable asset hash', async () => {
    const asset = snapshot().layers[0]!.asset
    expect(await avatarHash(avatarPng(asset.png, asset.width, asset.height)!)).toBe(asset.hash)
  })
  it('clear wins over a stalled decode and releases the stale image', async () => {
    let finish!: (value: string) => void
    const discarded: string[] = []
    const commits: number[] = []
    const receiver = new AvatarReceiver({
      now: () => 1000,
      prepare: () =>
        new Promise<string>((r) => {
          finish = r
        }),
      discard: (s: string) => discarded.push(s),
      commit: (s) => {
        commits.push(s.revision)
      },
      clear: () => {}
    })
    receiver.owner('PA_host')
    const first = receiver.accept({ ...snapshot(), layers: [snapshot().layers[0]!] })
    // Wait for the digest without sleeping or relying on clock timing.
    while (!finish) await new Promise<void>((r) => setImmediate(r))
    expect(await receiver.accept({ ...snapshot(), revision: 2, layers: [] })).toBe(true)
    finish('old-image')
    expect(await first).toBe(false)
    expect(discarded).toEqual(['old-image'])
    expect(commits).toEqual([2])
    expect(receiver.applied).toEqual({ publisherSid: 'PA_host', revision: 2 })
    expect(await receiver.accept(snapshot())).toBe(false)
  })
  it('owner replacement, expiry and failed hashes never acknowledge a stale asset', async () => {
    let now = 1000
    let clears = 0
    const receiver = new AvatarReceiver({
      now: () => now,
      prepare: async () => 'image',
      discard: () => {},
      commit: () => {},
      clear: () => {
        clears++
      }
    })
    receiver.owner('PA_host')
    const bad = snapshot()
    bad.layers[0]!.asset.hash = '0'.repeat(64)
    await expect(receiver.accept(bad)).rejects.toThrow('hash')
    expect(receiver.applied).toBeUndefined()
    expect(await receiver.accept({ ...snapshot(), revision: 2 })).toBe(true)
    now = 31000
    receiver.step()
    expect(receiver.applied).toBeUndefined()
    receiver.owner('PA_new')
    expect(await receiver.accept({ ...snapshot(), revision: 100 })).toBe(false)
    expect(clears).toBeGreaterThan(1)
  })
  it('pending paint retains a lease and failed paint clears visible pixels', async () => {
    let now = 1000
    let finish!: () => void
    let visible = false
    let fail = false
    const receiver = new AvatarReceiver({
      now: () => now,
      prepare: async () => 'image',
      discard: () => {},
      commit: async () => {
        visible = true
        if (fail) throw new Error('paint failed')
        await new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      clear: () => {
        visible = false
      }
    })
    receiver.owner('PA_host')
    const pending = receiver.accept(snapshot())
    while (!finish) await new Promise<void>((r) => setImmediate(r))
    expect(visible).toBe(true)
    expect(receiver.applied).toBeUndefined()
    now = 31000
    receiver.step()
    expect(visible).toBe(false)
    finish()
    expect(await pending).toBe(false)
    now = 1000
    fail = true
    await expect(receiver.accept({ ...snapshot(), revision: 2 })).rejects.toThrow('paint failed')
    expect(visible).toBe(false)
    expect(receiver.applied).toBeUndefined()
  })
})
