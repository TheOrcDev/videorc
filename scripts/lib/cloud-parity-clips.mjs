/** Maintained real-app acquisition, never imported/run by lightweight tests.
 * Reuses captured program pixels + final mix. Controlled fixture clock is NOT
 * evidence of managed source-to-show alignment, price or D8 qualification. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { waitFor, runMedia } from './cloud-managed-smoke.mjs'
import { MEDIA, audioMeasurements, colorFraction } from './cloud-parity-media.mjs'
import { analyzeRecording } from './recording-analyzer.mjs'
import { assessClipPackets } from './cloud-parity-clips-contract.mjs'
export async function exerciseProgramClips({ h, artifact, webRoot, output, report }) {
  assert.ok(
    artifact && existsSync(artifact),
    'Requires actual program acquisition; no fabricated artifact'
  )
  const root = join(output, 'clips-source')
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
  const text = readFileSync(join(root, 'index.m3u8'), 'utf8')
  const data = [...text.matchAll(/#EXTINF:([0-9.]+),\s*\n(part-\d+\.ts)/g)].map((m) => ({
    durationMs: Number(m[1]) * 1000,
    data: readFileSync(join(root, m[2]))
  }))
  assert.ok(
    data.reduce((n, s) => n + s.durationMs, 0) >= 36000,
    'Need a full marked 30-second window'
  )
  const require = createRequire(join(webRoot, 'package.json'))
  const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href)
  const { clipFixture } = await tsImport(join(webRoot, 'tests/fixtures/cloud-clips-kit.ts'), {
    parentURL: import.meta.url,
    tsconfig: join(webRoot, 'tsconfig.json')
  })
  const fixture = await clipFixture(h.showId, data)
  h.web.hooks.clips(fixture.clips)
  h.web.hooks.markerHandler((request) => fixture.markers(request))
  const observations = (report.clips = {
    status: 'running',
    managedAcceptance: 'not-run',
    productionQualified: false,
    sourceToShowClock: 'synthetic-local-fixture-only',
    cost: 'unmeasured',
    artifact: null
  })
  const sql = (q) =>
    JSON.parse(
      execFileSync('sqlite3', ['-json', join(h.appData, 'videorc.sqlite3'), q], {
        encoding: 'utf8'
      }) || '[]'
    )
  const status = async (id) => (await h.rpc('cloud.clips.jobs')).find((j) => j.id === id)
  let release
  try {
    assert.equal((await h.rpc('cloud.clips.status', { showId: h.showId })).enabled, false)
    await h.rpc('cloud.clips.enable', {
      showId: h.showId,
      consent: true,
      orientation: 'h',
      requestId: randomUUID()
    })
    const marker = await h.rpc('cloud.marker.create', {
      showId: h.showId,
      operationId: randomUUID(),
      kind: 'clip',
      lookbackSeconds: 30
    })
    assert.ok(marker.clipJob, 'The existing clip owner must queue actual extraction')
    const complete = await waitFor(
      async () => {
        const s = await status(marker.clipJob.id)
        return s?.state === 'complete' ? s : null
      },
      'marked program clip in Library',
      150000
    )
    const rows = sql(`SELECT * FROM sessions WHERE id='${complete.localSessionId}'`)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].mode, 'cloud-recording')
    assert.equal(rows[0].duration_ms, 30000)
    const path = rows[0].mp4_path
    const analysis = await analyzeRecording(path, {
      ffmpegPath: h.ffmpeg,
      ffprobePath: h.ffprobe,
      intendedFps: 30,
      expectAudio: true,
      gates: { avSyncTargetMs: 80, avSyncHardFailMs: 80 }
    })
    assert.ok(analysis.verdict.pass, analysis.verdict.failures.join('; '))
    const probe = JSON.parse(
      runMedia(h.ffprobe, [
        '-v',
        'error',
        '-show_packets',
        '-show_entries',
        'packet=codec_type,pts_time,dts_time,duration_time,flags',
        '-of',
        'json',
        path
      ]).toString()
    )
    observations.packetClock = assessClipPackets(probe, 30000)
    const pcm = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1'
    ])
    const tones = audioMeasurements(
      Float32Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4))
    )
    for (const lane of ['host', 'guest1', 'guest2', 'soundboard'])
      assert.ok(tones[lane] > MEDIA.analysis.audibleDbfs, `Missing mixed ${lane}`)
    const pixels = runMedia(h.ffmpeg, [
      '-v',
      'error',
      '-i',
      path,
      '-vf',
      'fps=2,scale=160:90',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      'pipe:1'
    ])
    for (const role of ['host', 'guest1', 'guest2', 'card']) {
      let hits = 0
      for (let at = 0; at + 43200 <= pixels.length; at += 43200)
        if (
          colorFraction(pixels.subarray(at, at + 43200), MEDIA.colors[role]) >
          MEDIA.analysis.minimumColorFraction
        )
          hits++
      assert.ok(hits >= 5, `Clip missing program ${role} pixels`)
    }
    const again = await h.rpc('cloud.clips.save', {
      showId: h.showId,
      markerId: marker.id,
      generation: fixture.ring.generation
    })
    assert.equal(again.localSessionId, complete.localSessionId)
    assert.equal(
      sql(`SELECT count(*) AS n FROM sessions WHERE id='${complete.localSessionId}'`)[0].n,
      1
    )
    let blocked = false
    const gate = new Promise((r) => {
      release = r
    })
    fixture.hold(async () => {
      blocked = true
      await gate
    })
    const second = await h.rpc('cloud.marker.create', {
      showId: h.showId,
      operationId: randomUUID(),
      kind: 'clip',
      lookbackSeconds: 30
    })
    await waitFor(() => blocked, 'segment read cancellation boundary')
    await h.rpc('cloud.clips.cancel', { id: second.clipJob.id })
    release()
    fixture.hold(null)
    await waitFor(
      async () => (await status(second.clipJob.id))?.state === 'cancelled',
      'cancelled clip'
    )
    assert.equal(
      sql(`SELECT count(*) AS n FROM sessions WHERE id='cloud-${second.clipJob.id}'`)[0].n,
      0
    )
    const journal = sql(
      `SELECT journal_json FROM cloud_program_clips WHERE id='${second.clipJob.id}'`
    )[0]
    assert.equal(
      JSON.parse(journal.journal_json).files.length,
      0,
      'Cancelled staging files removed'
    )
    fixture.unconfirm()
    await assert.rejects(
      h.rpc('cloud.clips.save', {
        showId: h.showId,
        markerId: marker.id,
        generation: fixture.ring.generation
      }),
      /clock|unconfirmed|refused/
    )
    fixture.expire()
    await assert.rejects(
      h.rpc('cloud.clips.save', {
        showId: h.showId,
        markerId: marker.id,
        generation: fixture.ring.generation
      })
    )
    await h.rpc('cloud.clips.discard', { id: complete.id })
    assert.ok(existsSync(path), 'Dismiss must keep Library artifact')
    observations.status = 'passed-local-fixture'
    observations.artifact = path
    observations.tones = tones
    writeFileSync(
      join(output, 'clips-analysis.json'),
      JSON.stringify({ observations, analysis }, null, 2) + '\n'
    )
  } finally {
    release?.()
    fixture.hold(null)
    h.web.hooks.clips(null)
    h.web.hooks.markerHandler(null)
  }
}
