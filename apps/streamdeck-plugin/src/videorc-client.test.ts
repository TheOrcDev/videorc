import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { WebSocketServer } from 'ws'

import {
  VideorcClient,
  bannerKeyIntent,
  bannerKeyTitle,
  defaultDiscoveryPath,
  soundKeyIntent,
  soundKeyTitle,
  readDiscovery
} from './videorc-client.js'

test('defaultDiscoveryPath targets the per-user Videorc app data dir', () => {
  const path = defaultDiscoveryPath()
  assert.ok(path.endsWith(join('Videorc', 'remote-control.json')))
  assert.ok(path.split(sep).length > 3, 'must be an absolute per-user location')
})

test('readDiscovery parses a valid pairing file and defaults host/protocol', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-sd-'))
  try {
    const path = join(dir, 'remote-control.json')
    writeFileSync(path, JSON.stringify({ port: 4242, token: 'secret' }))
    assert.deepEqual(readDiscovery(path), {
      host: '127.0.0.1',
      port: 4242,
      token: 'secret',
      protocol: 1
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readDiscovery returns null for missing, malformed, or incomplete files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-sd-'))
  try {
    assert.equal(readDiscovery(join(dir, 'missing.json')), null)

    const malformed = join(dir, 'malformed.json')
    writeFileSync(malformed, 'not json {')
    assert.equal(readDiscovery(malformed), null)

    const nullBody = join(dir, 'null.json')
    writeFileSync(nullBody, 'null')
    assert.equal(readDiscovery(nullBody), null)

    const missingToken = join(dir, 'incomplete.json')
    writeFileSync(missingToken, JSON.stringify({ port: 4242 }))
    assert.equal(readDiscovery(missingToken), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Plan 186: a Banner key names its banner and says ON while it shows.
test('bannerKeyTitle names the picked banner, ON while it shows, and says so when it is gone', () => {
  const describe = {
    banners: [
      { id: 'sponsor', name: 'Sponsor', shown: true },
      { id: 'follow', name: 'Follow me on X', shown: false }
    ]
  }
  assert.equal(bannerKeyTitle(describe, 'sponsor', true), 'Sponsor\nON')
  assert.equal(bannerKeyTitle(describe, 'follow', true), 'Follow me…')
  assert.equal(bannerKeyTitle(describe, 'deleted', true), 'Banner')
  assert.equal(bannerKeyTitle(describe, undefined, true), 'Banner')
  assert.equal(bannerKeyTitle({}, 'sponsor', true), 'Banner')
  assert.equal(bannerKeyTitle(describe, 'sponsor', false), 'Videorc\noffline')
})

test('bannerKeyIntent toggles the picked banner by id, and nothing before one is picked', () => {
  assert.deepEqual(bannerKeyIntent('sponsor'), { kind: 'bannerToggle', bannerId: 'sponsor' })
  assert.equal(bannerKeyIntent(undefined), null)
  assert.equal(bannerKeyIntent(''), null)
})

test('VideorcClient re-reads describe after each remote.state, one read at a time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'videorc-sd-'))
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const client = new VideorcClient(join(dir, 'remote-control.json'))
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    writeFileSync(
      join(dir, 'remote-control.json'),
      JSON.stringify({ host: '127.0.0.1', port: address.port, token: 'secret' })
    )
    const describes: string[] = []
    let shown = false
    let held: (() => void) | null = null
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const request = JSON.parse(String(raw)) as { id: string; method: string }
        if (request.method !== 'remote.describe') return
        describes.push(request.id)
        const answer = () =>
          socket.send(
            JSON.stringify({
              id: request.id,
              ok: true,
              payload: {
                describe: { banners: [{ id: 'sponsor', name: 'Sponsor', shown }] },
                state: { sessionActive: false }
              }
            })
          )
        // Hold the second read so two state events land while it is out.
        if (describes.length === 2) held = answer
        else answer()
      })
    })
    const seen: boolean[] = []
    client.on('describe', (describe) => seen.push(describe.banners[0].shown))
    client.start()
    while (seen.length < 1) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.deepEqual(seen, [false])

    // The app published: a banner now shows, and remote.state says something changed.
    shown = true
    const [socket] = [...server.clients]
    socket.send(JSON.stringify({ event: 'remote.state', payload: { sessionActive: false } }))
    while (describes.length < 2) await new Promise((resolve) => setTimeout(resolve, 5))
    socket.send(JSON.stringify({ event: 'remote.state', payload: { sessionActive: false } }))
    socket.send(JSON.stringify({ event: 'remote.state', payload: { sessionActive: false } }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // One read is out, so the two states wait for it instead of piling up.
    assert.equal(describes.length, 2)
    held!()
    while (describes.length < 3 || seen.length < 3) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.deepEqual(seen, [false, true, true])
    assert.equal(describes.length, 3)
  } finally {
    client.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

// Plan 189: a Play sound key names its sound and says ON while it plays.
test('soundKeyTitle names the picked sound, ON while it plays, and says so when it is gone', () => {
  const describe = {
    sounds: [
      { id: 'airhorn', name: 'Airhorn', playing: true },
      { id: 'trombone', name: 'Sad trombone', playing: false }
    ]
  }
  assert.equal(soundKeyTitle(describe, 'airhorn', true), 'Airhorn\nON')
  assert.equal(soundKeyTitle(describe, 'trombone', true), 'Sad tromb…')
  assert.equal(soundKeyTitle(describe, 'deleted', true), 'Sound')
  assert.equal(soundKeyTitle(describe, undefined, true), 'Sound')
  assert.equal(soundKeyTitle({}, 'airhorn', true), 'Sound')
  assert.equal(soundKeyTitle(describe, 'airhorn', false), 'Videorc\noffline')
})

test('soundKeyIntent presses the picked sound by id, and nothing before one is picked', () => {
  assert.deepEqual(soundKeyIntent('airhorn'), { kind: 'soundPlay', soundId: 'airhorn' })
  assert.equal(soundKeyIntent(undefined), null)
  assert.equal(soundKeyIntent(''), null)
})
