import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'

import {
  DownloadFileError,
  downloadFile,
  ffmpegOrgMirrorUrls,
  nextRetryDelayMs,
  parseSha256,
  sourceUrlsFromPin,
  uniqueHttpUrls
} from './download-file.mjs'

const body = Buffer.from('ffmpeg-source')
const sha256 = '2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae'

describe('download-file', () => {
  it('accepts official and www.ffmpeg.org source URLs and retries timeouts', async () => {
    assert.deepEqual(ffmpegOrgMirrorUrls('https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'), [
      'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      'https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'
    ])
    assert.deepEqual(
      sourceUrlsFromPin({
        sourceUrl: 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'
      }),
      ['https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz']
    )
    assert.deepEqual(uniqueHttpUrls(['https://a.test/x', 'https://a.test/x', 'ftp://a.test/x']), [
      'https://a.test/x'
    ])
    const pin = JSON.parse(
      readFileSync(new URL('../../vendor/ffmpeg/windows-capture-pin.json', import.meta.url), 'utf8')
    )
    assert.deepEqual(Object.keys(pin), ['version', 'sourceUrl', 'sourceSha256', 'protocol'])
    assert.equal(pin.sourceUrl, 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz')
    assert.equal(parseSha256(sha256), sha256)
    assert.equal(nextRetryDelayMs(1, 2_000), 2_000)
    assert.equal(nextRetryDelayMs(2, 2_000), 4_000)
    assert.equal(nextRetryDelayMs(8, 2_000), 60_000)

    const calls = []
    const sleeps = []
    const result = await downloadFile({
      urls: [
        'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
        'https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'
      ],
      destination: '/tmp/videorc-ffmpeg-source.tar.xz',
      sha256,
      attempts: 3,
      initialDelayMs: 5,
      timeoutMs: 1_000,
      fetchImpl: async (url) => {
        calls.push(url)
        if (calls.length < 3) {
          const error = new Error('The request was aborted due to timeout')
          error.cause = { code: 28 }
          throw error
        }
        return {
          ok: true,
          status: 200,
          body: Readable.toWeb(Readable.from(body))
        }
      },
      writeResponse: async () => undefined,
      sha256Of: async () => sha256,
      matchesExisting: async () => false,
      sleep: async (ms) => {
        sleeps.push(ms)
      }
    })

    assert.equal(result.reused, false)
    assert.equal(result.url, 'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz')
    assert.equal(result.attempt, 2)
    assert.deepEqual(calls, [
      'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      'https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'
    ])
    assert.deepEqual(sleeps, [5])

    const singleUrlCalls = []
    await downloadFile({
      urls: ['https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'],
      destination: '/tmp/videorc-ffmpeg-source.tar.xz',
      sha256,
      attempts: 1,
      fetchImpl: async (url) => {
        singleUrlCalls.push(url)
        if (url.includes('://ffmpeg.org/')) throw new Error('timeout 28')
        return { ok: true, status: 200, body: {} }
      },
      writeResponse: async () => undefined,
      sha256Of: async () => sha256,
      matchesExisting: async () => false
    })
    assert.deepEqual(singleUrlCalls, [
      'https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz',
      'https://www.ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'
    ])
  })

  it('reuses a verified local archive and refuses a checksum mismatch', async () => {
    const reused = await downloadFile({
      urls: ['https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'],
      destination: '/tmp/already-there.tar.xz',
      sha256,
      matchesExisting: async () => true,
      fetchImpl: async () => {
        throw new Error('should not fetch')
      }
    })
    assert.deepEqual(reused, {
      reused: true,
      destination: '/tmp/already-there.tar.xz',
      sha256
    })

    await assert.rejects(
      () =>
        downloadFile({
          urls: ['https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz'],
          destination: '/tmp/bad.tar.xz',
          sha256,
          attempts: 1,
          fetchImpl: async () => ({ ok: true, status: 200, body: {} }),
          writeResponse: async () => undefined,
          sha256Of: async () => '0'.repeat(64),
          matchesExisting: async () => false
        }),
      (error) => error instanceof DownloadFileError && error.code === 'exhausted'
    )
  })
})
