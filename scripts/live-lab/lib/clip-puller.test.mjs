import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CLIP_THRESHOLDS,
  analyzeClip,
  clipIncidents,
  ffmpegRecordArgs,
  isInsideRepo,
  pullClip,
  videoIdFromUrl,
  ytDlpUrlArgs
} from './clip-puller.mjs'

// The live lab runs on macOS and Linux only (POSIX paths, modes and shells).
const posixOnly = {
  skip: process.platform === 'win32' && 'the live lab runs on macOS and Linux only'
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HLS =
  'https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1/sig/SECRETSIG/index.m3u8'
const NOW = new Date('2026-10-12T15:00:00Z')

const CLEAN = {
  hasVideo: true,
  hasAudio: true,
  longestFreezeMs: 0,
  maxAudioGapMs: 23,
  avOffsetMs: 40
}

async function withDir(work) {
  const dir = await mkdtemp(join(tmpdir(), 'videorc-clip-puller-'))
  try {
    await work(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// A runner standing in for yt-dlp and ffmpeg: yt-dlp prints the HLS URL(s);
// ffmpeg "records" by writing bytes to its last argument.
function fakeRunner({ urls = [HLS], ytCode = 0, ffCode = 0, writeClip = true } = {}) {
  const calls = []
  const runner = async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'yt-dlp') {
      return {
        code: ytCode,
        stdout: `${urls.join('\n')}\n`,
        stderr: ytCode ? 'ERROR: offline' : ''
      }
    }
    if (writeClip) await writeFile(args.at(-1), Buffer.from('fake mpegts bytes'))
    return { code: ffCode, stdout: '', stderr: ffCode ? `error opening ${HLS}` : '' }
  }
  return { runner, calls }
}

const fakeAnalyze = (summary) => async () => ({
  summary,
  incidents: clipIncidents(summary)
})

test('video ids from watch, live, youtu.be and shorts URLs', () => {
  assert.equal(videoIdFromUrl('https://www.youtube.com/watch?v=abcDEF12345'), 'abcDEF12345')
  assert.equal(videoIdFromUrl('https://youtube.com/live/abcDEF12345?si=x'), 'abcDEF12345')
  assert.equal(videoIdFromUrl('https://youtu.be/abcDEF12345'), 'abcDEF12345')
  assert.equal(videoIdFromUrl('https://m.youtube.com/shorts/abcDEF12345'), 'abcDEF12345')
  assert.equal(videoIdFromUrl('https://example.com/watch?v=abcDEF12345'), null)
  assert.equal(videoIdFromUrl('not a url'), null)
})

test('yt-dlp resolves from the live edge; ffmpeg copies N seconds of one or two inputs', () => {
  const yt = ytDlpUrlArgs('https://www.youtube.com/watch?v=abc')
  assert.ok(yt.includes('--no-live-from-start'))
  assert.ok(yt.includes('-g'))
  assert.ok(!yt.includes('--download-sections'))
  assert.deepEqual(ffmpegRecordArgs(['a'], 120, '/x/clip.ts').slice(-9), [
    '-i',
    'a',
    '-t',
    '120',
    '-c',
    'copy',
    '-f',
    'mpegts',
    '/x/clip.ts'
  ])
  const split = ffmpegRecordArgs(['v', 'a'], 30, '/x/clip.ts')
  assert.deepEqual(split.slice(split.indexOf('-map'), split.indexOf('-map') + 4), [
    '-map',
    '0:v:0',
    '-map',
    '1:a:0'
  ])
})

test('plan 166 thresholds: freeze > 1 s, audio gap > 100 ms, A/V > 150 ms', () => {
  assert.deepEqual(clipIncidents(CLEAN), [])
  const bad = clipIncidents({
    hasVideo: true,
    longestFreezeMs: 1200,
    maxAudioGapMs: 140,
    avOffsetMs: -180
  })
  assert.deepEqual(
    bad.map((incident) => incident.signature),
    ['clip:freeze', 'clip:audio-gap', 'clip:av-offset']
  )
  assert.deepEqual(
    clipIncidents({ ...CLEAN, longestFreezeMs: 1000, maxAudioGapMs: 100, avOffsetMs: 150 }),
    []
  )
  assert.deepEqual(
    clipIncidents({ hasVideo: false }).map((incident) => incident.signature),
    ['clip:no-video']
  )
  assert.equal(CLIP_THRESHOLDS.maxFreezeMs, 1000)
})

test('analyzeClip uses the recording analyzer + A/V sync and tolerates no flash pairs', async () => {
  const analyze = async (path) => ({
    verdict: { pass: false, failures: ['freeze'], warnings: [] },
    metrics: {
      hasVideo: true,
      hasAudio: true,
      durationSeconds: 120,
      width: 1920,
      height: 1080,
      avgFps: 30,
      longestFreezeMs: 1500,
      freezeCount: 1,
      maxAudioGapMs: 21,
      longestSilenceMs: 0,
      path
    }
  })
  const result = await analyzeClip('/clip.ts', {
    analyze,
    measureSync: async () => ({ medianOffsetMs: null, pairs: [] })
  })
  assert.equal(result.summary.avOffsetMs, null)
  assert.equal(result.summary.avSyncError, 'no flash/click pairs')
  assert.deepEqual(result.summary.analyzerFailures, ['freeze'])
  assert.deepEqual(
    result.incidents.map((incident) => incident.signature),
    ['clip:freeze']
  )

  const thrown = await analyzeClip('/clip.ts', {
    analyze,
    measureSync: async () => {
      throw new Error('ffmpeg missing')
    }
  })
  assert.equal(thrown.summary.avSyncError, 'ffmpeg missing')
})

test(
  'clean clip: analysis JSON kept 0600, media deleted, signed URL never stored',
  posixOnly,
  async () => {
    await withDir(async (dir) => {
      const { runner, calls } = fakeRunner()
      const checked = []
      const result = await pullClip({
        url: 'https://www.youtube.com/live/ownVideo123',
        seconds: 120,
        outDir: dir,
        runner,
        isOwnVideo: async (id) => {
          checked.push(id)
          return true
        },
        analyze: fakeAnalyze(CLEAN),
        now: () => NOW
      })
      assert.equal(result.status, 'analyzed')
      assert.deepEqual(checked, ['ownVideo123'])
      assert.equal(result.kept, false)
      assert.equal(result.clipPath, null)
      assert.deepEqual(result.incidents, [])
      assert.deepEqual(await readdir(dir), ['clip-ownVideo123-20261012T150000Z.analysis.json'])
      assert.equal((await stat(result.analysisPath)).mode & 0o777, 0o600)
      const saved = await readFile(result.analysisPath, 'utf8')
      assert.ok(!saved.includes('SECRETSIG'))
      assert.equal(JSON.parse(saved).summary.avOffsetMs, 40)

      assert.equal(calls[0].command, 'yt-dlp')
      assert.equal(calls[0].args.at(-1), 'https://www.youtube.com/watch?v=ownVideo123')
      assert.equal(calls[1].command, 'ffmpeg')
      assert.ok(calls[1].args.includes(HLS))
      assert.equal(calls[1].options.timeoutMs, 120_000 + 90_000)
    })
  }
)

test('incident clip keeps the media (unless keepOnIncident is off)', async () => {
  await withDir(async (dir) => {
    const frozen = { ...CLEAN, longestFreezeMs: 4000 }
    const kept = await pullClip({
      url: 'https://youtu.be/ownVideo123',
      outDir: dir,
      runner: fakeRunner().runner,
      isOwnVideo: async () => true,
      analyze: fakeAnalyze(frozen),
      now: () => NOW
    })
    assert.equal(kept.kept, true)
    assert.ok(existsSync(kept.clipPath))
    assert.equal(kept.incidents[0].signature, 'clip:freeze')

    const dropped = await pullClip({
      url: 'https://youtu.be/ownVideo123',
      outDir: dir,
      runner: fakeRunner().runner,
      isOwnVideo: async () => true,
      analyze: fakeAnalyze(frozen),
      keepOnIncident: false,
      now: () => new Date('2026-10-12T15:30:00Z')
    })
    assert.equal(dropped.kept, false)
    assert.equal(dropped.incidents.length, 1)
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.ts')).length, 1)
  })
})

test('the terms gate: disabled, not own, unverified or failed check never downloads', async () => {
  await withDir(async (dir) => {
    const { runner, calls } = fakeRunner()
    const base = { url: 'https://youtu.be/someVideo99', outDir: dir, runner }
    assert.deepEqual(await pullClip({ ...base, clipPull: false, isOwnVideo: async () => true }), {
      status: 'skipped',
      reason: 'clip-pull-disabled'
    })
    assert.equal(
      (await pullClip({ ...base, isOwnVideo: async () => false })).reason,
      'not-own-video'
    )
    assert.equal((await pullClip(base)).reason, 'ownership-unverified')
    assert.equal(
      (
        await pullClip({
          ...base,
          isOwnVideo: async () => {
            throw new Error('quota refused')
          }
        })
      ).reason,
      'ownership-check-failed'
    )
    assert.equal(
      (await pullClip({ ...base, url: 'https://example.com/v.mp4', isOwnVideo: async () => true }))
        .reason,
      'not-a-youtube-video-url'
    )
    assert.equal(calls.length, 0)
  })
})

test('never writes media inside the repo', async () => {
  assert.equal(isInsideRepo(REPO_ROOT), true)
  assert.equal(isInsideRepo(join(REPO_ROOT, 'scripts', 'clips')), true)
  assert.equal(isInsideRepo(tmpdir()), false)
  assert.equal(isInsideRepo(`${REPO_ROOT}-sibling`), false)
  await assert.rejects(
    pullClip({
      url: 'https://youtu.be/ownVideo123',
      outDir: join(REPO_ROOT, 'clips'),
      runner: fakeRunner().runner,
      isOwnVideo: async () => true
    }),
    /inside the repo/
  )
})

test('yt-dlp or ffmpeg failure reports without the signed URL and leaves no media', async () => {
  await withDir(async (dir) => {
    const offline = await pullClip({
      url: 'https://youtu.be/ownVideo123',
      outDir: dir,
      runner: fakeRunner({ ytCode: 1, urls: [] }).runner,
      isOwnVideo: async () => true
    })
    assert.deepEqual([offline.status, offline.reason], ['failed', 'no-live-url'])

    const broken = await pullClip({
      url: 'https://youtu.be/ownVideo123',
      outDir: dir,
      runner: fakeRunner({ ffCode: 1 }).runner,
      isOwnVideo: async () => true,
      now: () => NOW
    })
    assert.deepEqual([broken.status, broken.reason], ['failed', 'record-failed'])
    assert.ok(!broken.detail.includes('SECRETSIG'))
    assert.deepEqual(await readdir(dir), [])
  })
})
