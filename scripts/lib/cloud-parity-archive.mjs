/** S21c real native archive acquisition from the S21a captured program artifact.
 * Never a unit test: actual app restart, account API transport, disk, FFmpeg,
 * Library registration and final pixels/tones. Local fixture is not provider proof.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { analyzeRecording } from './recording-analyzer.mjs'
import { MEDIA, audioMeasurements, colorFraction } from './cloud-parity-media.mjs'

export async function exerciseLocalArchive({ h, artifact, output, report }) {
  assert.ok(artifact, 'Actual program acquisition must run first; no generated-color fallback')
  const root = join(output, 'archive-source')
  mkdirSync(root, { recursive: true })
  runMedia(h.ffmpeg, [
    '-v',
    'error',
    '-y',
    '-i',
    artifact,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0',
    '-c',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '2',
    '-hls_list_size',
    '0',
    '-hls_segment_filename',
    join(root, 'part-%03d.ts'),
    join(root, 'index.m3u8')
  ])
  const text = readFileSync(join(root, 'index.m3u8'), 'utf8'),
    segments = []
  let end = 0
  for (const match of text.matchAll(/#EXTINF:([0-9.]+),\s*\n(part-\d+\.ts)/g)) {
    const data = readFileSync(join(root, match[2])),
      durationMs = Math.round(Number(match[1]) * 1000)
    segments.push({
      sequence: segments.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      startMs: end,
      endMs: end + durationMs,
      durationMs,
      data
    })
    end += durationMs
  }
  assert.ok(segments.length >= 3, 'Archive restart needs at least three real segments')
  const generation = randomUUID(),
    expiresAt = Date.now() + 300000,
    takeId = `tk_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const prefix = `talk/fixture-owner/${h.showId}/h/${takeId}/`,
    id = `rec_${createHash('sha256').update(`${prefix}index.m3u8`).digest('base64url').slice(0, 22)}`
  const item = {
    id,
    takeId,
    showId: h.showId,
    orientation: 'h',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    seconds: end / 1000,
    bytes: segments.reduce((n, s) => n + s.bytes, 0),
    format: 'segments',
    liveIntervalIds: [],
    associationKnown: true
  }
  let visible = 1,
    finished = false,
    loss = 0,
    forceGap = false
  const snapshot = () => ({
    version: 1,
    qualified: true,
    ownerKey: createHash('sha256').update('fixture-owner').digest('hex'),
    showId: h.showId,
    generation,
    expiresAt,
    recordingActive: h.web.snapshot(h.showId).state.recording.active,
    recordingComplete: finished,
    recording: h.web.snapshot(h.showId).state.recording.active || finished ? item : null,
    segments:
      h.web.snapshot(h.showId).state.recording.active || finished
        ? segments.slice(forceGap ? 1 : 0, visible).map(({ data: _data, ...s }) => s)
        : []
  })
  h.web.hooks.archive(({ method, url, body }) => {
    if (method === 'GET' && !url.search)
      return {
        body: {
          available: true,
          reason: 'SIMULATED local acquisition; production remains unqualified'
        }
      }
    if (method === 'POST') {
      assert.equal(body.consent, true)
      return { body: snapshot() }
    }
    if (url.searchParams.get('generation') !== generation)
      return { status: 410, body: { error: 'stale-generation' } }
    if (url.searchParams.has('segment')) {
      if (loss-- > 0) return { status: 503, body: { error: 'fixture-network-loss' } }
      const segment = segments.find((s) => String(s.sequence) === url.searchParams.get('segment'))
      return segment
        ? { body: segment.data, contentType: 'video/mp2t' }
        : { status: 410, body: { error: 'segment-expired' } }
    }
    return { body: snapshot() }
  })
  const sql = (q) =>
    JSON.parse(
      execFileSync('sqlite3', ['-json', join(h.appData, 'videorc.sqlite3'), q], {
        encoding: 'utf8'
      }) || '[]'
    )
  const status = async (id) => (await h.rpc('cloud.archive.status')).find((j) => j.id === id)
  const start = async () => {
    const grant = await h.command('authorize-smoke-resource', {
      kind: 'output-directory',
      path: h.env.VIDEORC_RECORDINGS_DIR
    })
    return h.rpc('cloud.archive.start', {
      consent: true,
      showId: h.showId,
      orientation: 'h',
      outputDirectoryCapability: grant.capabilityId
    })
  }
  const observations = (report.archive = {
    status: 'running',
    managedAcceptance: 'not-run',
    qualification: false,
    source: 'captured-real-program-via-loopback-account-api',
    artifacts: []
  })
  try {
    const callsBefore = h.web.calls.filter((c) => c.route === 'recording').length
    const job = await start()
    assert.equal(
      h.web.calls.filter((c) => c.route === 'recording').length,
      callsBefore,
      'Archive must not start Record'
    )
    await h.rpc('cloud.recording.start') // Explicit, independently requested fixture recording.
    await waitFor(
      async () => (await status(job.id))?.segments === 1,
      'first archived program segment'
    )
    await h.kill()
    await h.launch()
    assert.equal((await status(job.id)).state, 'interrupted')
    visible = segments.length
    loss = 1
    await h.rpc('cloud.archive.resume', { id: job.id })
    await waitFor(
      async () => (await status(job.id))?.state === 'interrupted',
      'bounded network loss remains resumable'
    )
    await h.rpc('cloud.archive.resume', { id: job.id })
    await waitFor(
      async () => (await status(job.id))?.segments === segments.length,
      'segments recovered without duplicates'
    )
    await h.rpc('cloud.recording.stop')
    finished = true
    const complete = await waitFor(
      async () => {
        const s = await status(job.id)
        return s?.state === 'complete' ? s : null
      },
      'verified archive in Library',
      90000
    )
    const rows = sql(`SELECT * FROM sessions WHERE id='${complete.localSessionId}'`)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].started_at, item.startedAt)
    const result = await analyzeRecording(rows[0].mp4_path, {
      ffmpegPath: h.ffmpeg,
      ffprobePath: h.ffprobe,
      intendedFps: 30,
      expectAudio: true,
      gates: { avSyncTargetMs: 80, avSyncHardFailMs: 80 }
    })
    assert.ok(result.verdict.pass, result.verdict.failures.join('; '))
    const raw = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      rows[0].mp4_path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ])
    const pcm = Float32Array.from({ length: raw.length / 4 }, (_, i) => raw.readFloatLE(i * 4)),
      tones = audioMeasurements(pcm)
    for (const voice of ['host', 'guest1', 'guest2', 'soundboard'])
      assert.ok(tones[voice] > MEDIA.analysis.audibleDbfs, `Missing ${voice}`)
    const pixels = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      rows[0].mp4_path,
      '-vf',
      'fps=5,scale=160:90',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    for (const who of ['host', 'guest1', 'guest2', 'card']) {
      let hits = 0
      for (let at = 0; at + 43200 <= pixels.length; at += 43200)
        if (
          colorFraction(pixels.subarray(at, at + 43200), MEDIA.colors[who]) >
          MEDIA.analysis.minimumColorFraction
        )
          hits++
      assert.ok(hits >= 5, `Missing final archive pixels: ${who}`)
    }
    await h.rpc('cloud.archive.discard', { id: job.id })
    assert.ok(readFileSync(rows[0].mp4_path).length > 0, 'Discard must preserve Library file')
    // A missed initial window is never spliced into a complete take.
    forceGap = true
    finished = false
    const gap = await start()
    await h.rpc('cloud.recording.start')
    await waitFor(
      async () => (await status(gap.id))?.state === 'partial',
      'unrecoverable gap is explicit'
    )
    assert.equal(sql(`SELECT id FROM sessions WHERE id='${complete.localSessionId}'`).length, 1)
    observations.artifacts.push({ file: rows[0].mp4_path, analysis: result, tones })
    observations.status = 'passed-local-archive'
  } catch (error) {
    observations.status = 'failed'
    throw error
  } finally {
    h.web.hooks.archive(null)
    writeFileSync(join(output, 'archive.json'), JSON.stringify(observations, null, 2))
  }
}
