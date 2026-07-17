import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { defaultDiscoveryPath, readDiscovery } from './videorc-client.js'

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
