import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'

import {
  PublishRefused,
  checkFileLocally,
  findLocalSensitive,
  guardFiles,
  guardText,
  loadRedactor,
  pngTextChunks,
  sanitizeLine
} from './publish-guard.mjs'

// Secret-shaped strings are assembled at runtime so this file itself holds none.
const SHAPES = {
  'stream key': ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('-'),
  email: ['lab.viewer', 'example.com'].join('@'),
  'home path': ['', 'Users', 'videorc-lab', '.videorc-live-lab', 'config.json'].join('/'),
  'google access token': `${'ya29'}.${'a'.repeat(40)}`,
  'refresh token': `${'1//0'}${'b'.repeat(40)}`,
  'client secret': `${'GOCSPX'}-${'c'.repeat(28)}`,
  'client id': `123456789012-${'d'.repeat(32)}.apps.googleusercontent.com`,
  'github token': `${'ghp'}_${'e'.repeat(36)}`,
  'private key': `-----BEGIN ${'PRIVATE'} KEY-----`,
  webhook: `https://discord.com/api/${'webhooks'}/123/${'f'.repeat(30)}`,
  'stream url': `${'rtmps'}://a.rtmp.youtube.com/live2/x`,
  assignment: `client_secret = "${'g'.repeat(20)}"`,
  'query credential': `https://x.test/?access_token=${'h'.repeat(20)}`,
  'opaque token': `Zq9${'xY7'.repeat(11)}`
}

const CLEAN = [
  '# Run 2026-10-12-chat-a1b2c3',
  'Outcome: **warn**. Renderer RSS slope 12.5 MB/h (threshold 30).',
  'VOD: https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'Evidence: charts/rss-renderer.png, census.csv',
  'Started 2026-10-12T06:00:00.000Z, run id 2026-10-12-chat-a1b2c3.',
  'Signature stream:noData-while-live, severity P0.',
  'Build sha 0123456789abcdef0123456789abcdef01234567 (lab-candidate-0123456).',
  'Report: https://github.com/TheOrcDev/videorc-live-lab-reports/blob/main/runs/2026-10-12-chat-a1b2c3/report.md',
  'The lab token refreshed; secret rotation is owed.'
].join('\n')

const fakeRedactor = {
  async assertPublishable(paths) {
    for (const path of paths) {
      if ((await readFile(path, 'utf8').catch(() => '')).includes('U9-HIT')) {
        throw Object.assign(new Error('REDACTION_FAILED'), { code: 'REDACTION_FAILED' })
      }
    }
  },
  findSensitive: (text) => (text.includes('U9-HIT') ? [{ pattern: 'u9', index: 0 }] : [])
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-guard-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function crc32(buffer) {
  let crc = ~0
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(textChunks = []) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    signature,
    chunk('IHDR', Buffer.alloc(13)),
    ...textChunks,
    chunk('IDAT', deflateSync(Buffer.alloc(4))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test('every secret shape is found, and a clean report is not', () => {
  assert.deepEqual(findLocalSensitive(CLEAN), [])
  for (const [name, value] of Object.entries(SHAPES)) {
    assert.ok(findLocalSensitive(`prefix ${value} suffix`).length > 0, name)
  }
})

test('sanitizeLine replaces hits and keeps the rest', () => {
  const line = sanitizeLine(`viewer ${SHAPES.email} sent ${SHAPES['stream key']} at step 3`)
  assert.equal(line, 'viewer [redacted] sent [redacted] at step 3')
  assert.equal(sanitizeLine('step 3 ok'), 'step 3 ok')
})

test('checkFileLocally allows clean text and PNGs, refuses other types and hits', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'report.md'), CLEAN)
  await writeFile(join(dir, 'clean.png'), png([chunk('tEXt', Buffer.from('Software\0chart'))]))
  await writeFile(
    join(dir, 'leaky.png'),
    png([chunk('tEXt', Buffer.from(`Comment\0${SHAPES['home path']}`))])
  )
  const compressed = Buffer.concat([
    Buffer.from('Comment\0\0'),
    deflateSync(Buffer.from(SHAPES.email))
  ])
  await writeFile(join(dir, 'zleaky.png'), png([chunk('zTXt', compressed)]))
  await writeFile(join(dir, 'fake.png'), 'not a png')
  await writeFile(join(dir, 'census.csv'), 'a,b\n')
  await writeFile(join(dir, 'leak.json'), JSON.stringify({ note: SHAPES['google access token'] }))
  await writeFile(join(dir, 'binary.md'), Buffer.from([0x41, 0x00, 0x42]))

  assert.deepEqual(await checkFileLocally(join(dir, 'report.md')), [])
  assert.deepEqual(await checkFileLocally(join(dir, 'clean.png')), [])
  assert.deepEqual(await checkFileLocally(join(dir, 'leaky.png')), [
    { file: 'leaky.png', pattern: 'home path' }
  ])
  assert.deepEqual(await checkFileLocally(join(dir, 'zleaky.png')), [
    { file: 'zleaky.png', pattern: 'email' }
  ])
  assert.match((await checkFileLocally(join(dir, 'fake.png')))[0].pattern, /bad image/)
  assert.equal(
    (await checkFileLocally(join(dir, 'census.csv')))[0].pattern,
    'file type not allowed'
  )
  assert.equal((await checkFileLocally(join(dir, 'leak.json')))[0].pattern, 'token prefix')
  assert.equal(
    (await checkFileLocally(join(dir, 'binary.md')))[0].pattern,
    'binary data in a text file'
  )
  assert.equal((await checkFileLocally(join(dir, 'missing.md')))[0].pattern, 'missing')
})

test('pngTextChunks reads tEXt, zTXt and iTXt', () => {
  const itxt = Buffer.concat([Buffer.from('Title\0\0\0en\0Titel\0'), Buffer.from('hello')])
  const texts = pngTextChunks(png([chunk('tEXt', Buffer.from('k\0v')), chunk('iTXt', itxt)]))
  assert.ok(texts.includes('k\0v'))
  assert.ok(texts.includes('hello'))
  assert.throws(() => pngTextChunks(Buffer.from('GIF89a')), /not a PNG/)
})

test('guardFiles runs both checks and names file + pattern, never the text', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'report.md'), CLEAN)
  await guardFiles([join(dir, 'report.md')], { redactor: fakeRedactor })

  await writeFile(join(dir, 'local.md'), `key ${SHAPES['stream key']}`)
  await assert.rejects(
    guardFiles([join(dir, 'report.md'), join(dir, 'local.md')], { redactor: fakeRedactor }),
    (error) => {
      assert.ok(error instanceof PublishRefused)
      assert.equal(error.code, 'REDACTION_FAILED')
      assert.deepEqual(error.problems, [{ file: 'local.md', pattern: 'stream key' }])
      assert.ok(!error.message.includes(SHAPES['stream key']))
      return true
    }
  )

  // Only U9 sees this one: it still refuses.
  await writeFile(join(dir, 'u9.md'), 'U9-HIT')
  await assert.rejects(
    guardFiles([join(dir, 'u9.md')], { redactor: fakeRedactor }),
    /assertPublishable refused/
  )

  // No U9 module: refused, fail closed.
  await assert.rejects(
    guardFiles([join(dir, 'report.md')], { redactor: null }),
    (error) => error.code === 'REDACTION_UNAVAILABLE'
  )
})

test('guardText uses U9 findSensitive, or assertPublishable on a temp copy', async (t) => {
  const dir = await tempDir(t)
  assert.equal(await guardText('all clear', 'body', { redactor: fakeRedactor }), 'all clear')
  await assert.rejects(
    guardText(`mail ${SHAPES.email}`, 'body', { redactor: fakeRedactor }),
    /body: email/
  )
  await assert.rejects(guardText('U9-HIT', 'body', { redactor: fakeRedactor }), /redact\.mjs u9/)
  const onlyAssert = { assertPublishable: fakeRedactor.assertPublishable, findSensitive: null }
  const writeTemp = async (text) => {
    const path = join(dir, 'temp.txt')
    await writeFile(path, text)
    return { path, cleanup: () => rm(path, { force: true }) }
  }
  await guardText('fine', 'body', { redactor: onlyAssert, writeTemp })
  await assert.rejects(
    guardText('U9-HIT', 'body', { redactor: onlyAssert, writeTemp }),
    /assertPublishable refused/
  )
  await assert.rejects(guardText('fine', 'body', { redactor: onlyAssert }), /no U9 text check/)
})

test('loadRedactor is lazy: a missing module is null, other errors throw', async () => {
  const missing = Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(await loadRedactor({ importer: async () => Promise.reject(missing) }), null)
  assert.equal(await loadRedactor({ importer: async () => ({ redactText: () => '' }) }), null)
  const loaded = await loadRedactor({
    importer: async () => ({ assertPublishable: () => {}, findSensitive: () => [] })
  })
  assert.equal(typeof loaded.assertPublishable, 'function')
  await assert.rejects(
    loadRedactor({ importer: async () => Promise.reject(new SyntaxError('bad')) }),
    SyntaxError
  )
})
