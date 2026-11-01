import assert from 'node:assert/strict'
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  configPath,
  emptyConfig,
  fingerprint,
  inspectPermissions,
  labDir,
  mergeStreamKeys,
  normalizeHandle,
  parseClientJson,
  readConfig,
  redact,
  sameHandle,
  summarizeConfig,
  writeConfig
} from './config.mjs'

const POSIX = process.platform !== 'win32'
const CLIENT_ID = '123456789012-abcdef0123456789.apps.googleusercontent.com'
const CLIENT_SECRET = 'GOCSPX-fakeSecretValue1234'
const KEY_H = 'abcd-efgh-ijkl-mnop-qr12'
const KEY_V = 'wxyz-wxyz-wxyz-wxyz-zz99'
const REFRESH = '1//0fakeRefreshTokenValueXYZ9'

async function tempLab() {
  const root = await mkdtemp(join(tmpdir(), 'videorc-live-lab-test-'))
  return { root, dir: join(root, 'lab') }
}

function fullConfig() {
  return {
    ...emptyConfig(),
    client: { id: CLIENT_ID, secret: CLIENT_SECRET },
    streamKeys: {
      horizontal: { label: 'Videorc lab', key: KEY_H },
      vertical: { label: 'Videorc lab vertical', key: KEY_V }
    },
    roles: {
      broadcaster: {
        refreshToken: REFRESH,
        channelId: 'UCabc',
        channelTitle: 'Videorc',
        channelHandle: '@videorcapp',
        authorizedAt: '2026-10-12T10:00:00.000Z'
      }
    }
  }
}

test('labDir honours VIDEORC_LIVE_LAB_DIR and defaults under the home dir', () => {
  assert.equal(labDir({ VIDEORC_LIVE_LAB_DIR: '/tmp/x' }), '/tmp/x')
  assert.match(labDir({}), /\.videorc-live-lab$/)
})

test('readConfig returns null when nothing is stored', async () => {
  const { root, dir } = await tempLab()
  try {
    assert.equal(await readConfig(dir), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('writeConfig round-trips and leaves no temp file behind', async () => {
  const { root, dir } = await tempLab()
  try {
    await writeConfig(dir, fullConfig())
    assert.deepEqual(await readConfig(dir), fullConfig())
    assert.deepEqual(await readdir(dir), ['config.json'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test(
  'writeConfig makes the dir 0700 and the file 0600, and tightens a loose dir',
  { skip: !POSIX },
  async () => {
    const { root, dir } = await tempLab()
    try {
      await writeConfig(dir, emptyConfig())
      assert.deepEqual(await inspectPermissions(dir), { dirMode: 0o700, fileMode: 0o600 })

      await chmod(dir, 0o755)
      await chmod(configPath(dir), 0o644)
      assert.deepEqual(await inspectPermissions(dir), { dirMode: 0o755, fileMode: 0o644 })

      await writeConfig(dir, emptyConfig())
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      assert.equal((await stat(configPath(dir))).mode & 0o777, 0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('inspectPermissions reports a missing config as null', async () => {
  const { root, dir } = await tempLab()
  try {
    assert.deepEqual(await inspectPermissions(dir), { dirMode: null, fileMode: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readConfig rejects broken JSON and an unknown version', async () => {
  const { root, dir } = await tempLab()
  try {
    await writeConfig(dir, emptyConfig())
    await writeFile(configPath(dir), '{nope')
    await assert.rejects(readConfig(dir), /not valid JSON/)
    await writeFile(configPath(dir), JSON.stringify({ version: 99 }))
    await assert.rejects(readConfig(dir), /version 99/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('fingerprint shows only the last 4 characters', () => {
  assert.equal(fingerprint(KEY_H), '****qr12')
  assert.equal(fingerprint('short'), '****')
  assert.equal(fingerprint(''), '(not set)')
  assert.equal(fingerprint(undefined), '(not set)')
})

test('redact removes every stored secret and extra values', () => {
  const config = fullConfig()
  const access = 'ya29.fakeAccessTokenValue5678'
  const text = `id=${CLIENT_ID} secret=${CLIENT_SECRET} h=${KEY_H} v=${KEY_V} rt=${REFRESH} at=${access}`
  const output = redact(text, config, [access])
  for (const secret of [CLIENT_ID, CLIENT_SECRET, KEY_H, KEY_V, REFRESH, access]) {
    assert.ok(!output.includes(secret), `leaked ${fingerprint(secret)}`)
  }
  assert.match(output, /h=\*\*\*\*qr12/)
  assert.match(output, /at=\*\*\*\*5678/)
  assert.equal(redact('nothing here', null), 'nothing here')
})

test('summarizeConfig never contains a full secret', () => {
  const text = summarizeConfig(fullConfig()).join('\n')
  for (const secret of [CLIENT_SECRET, KEY_H, KEY_V, REFRESH, CLIENT_ID]) {
    assert.ok(!text.includes(secret))
  }
  assert.match(text, /\*\*\*\*zz99/)
  assert.match(text, /viewer\s+\(not authorized\)/)
})

test('parseClientJson accepts a Desktop client download', () => {
  const text = JSON.stringify({
    installed: {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: ['http://localhost']
    }
  })
  assert.deepEqual(parseClientJson(text), { id: CLIENT_ID, secret: CLIENT_SECRET })
})

test('parseClientJson rejects a Web client, garbage and malformed values', () => {
  assert.throws(
    () =>
      parseClientJson(
        JSON.stringify({ web: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET } })
      ),
    /Desktop app client/
  )
  assert.throws(() => parseClientJson('not json'), /not valid JSON/)
  assert.throws(() => parseClientJson('{}'), /no "installed" section/)
  assert.throws(
    () =>
      parseClientJson(
        JSON.stringify({ installed: { client_id: 'abc', client_secret: CLIENT_SECRET } })
      ),
    /client id/
  )
  assert.throws(
    () =>
      parseClientJson(JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: '' } })),
    /client secret/
  )
})

test('parseClientJson error messages never echo the secret', () => {
  try {
    parseClientJson(
      JSON.stringify({ installed: { client_id: 'bad', client_secret: CLIENT_SECRET } })
    )
    assert.fail('expected a throw')
  } catch (error) {
    assert.ok(!error.message.includes(CLIENT_SECRET))
  }
})

test('mergeStreamKeys keeps stored keys on blank input and validates new ones', () => {
  const now = new Date('2026-10-12T12:00:00.000Z')
  const first = mergeStreamKeys({}, { horizontal: KEY_H, vertical: '' }, now)
  assert.deepEqual(first, {
    horizontal: { label: 'Videorc lab', key: KEY_H, updatedAt: now.toISOString() }
  })
  const second = mergeStreamKeys(first, { horizontal: '  ', vertical: ` ${KEY_V} ` }, now)
  assert.equal(second.horizontal.key, KEY_H)
  assert.equal(second.vertical.key, KEY_V)
  assert.equal(second.vertical.label, 'Videorc lab vertical')
  assert.throws(() => mergeStreamKeys(first, { vertical: 'too short' }, now), /stream key/)
  assert.throws(
    () => mergeStreamKeys(first, { vertical: 'has a space in the key' }, now),
    /stream key/
  )
})

test('handles normalize from URLs and compare case-insensitively', () => {
  assert.equal(normalizeHandle('youtube.com/@VideorcApp'), '@VideorcApp')
  assert.equal(normalizeHandle('https://www.youtube.com/@VideorcApp'), '@VideorcApp')
  assert.equal(normalizeHandle('VideorcApp'), '@VideorcApp')
  assert.ok(sameHandle('@videorcapp', '@VideorcApp'))
  assert.ok(!sameHandle('@someoneelse', '@VideorcApp'))
})
