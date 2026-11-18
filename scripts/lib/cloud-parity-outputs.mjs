/** S17: actual local LiveKit egress of the actual program pages, not a
 * re-encoded browser screenshot. Needs installed local egress/Redis binaries.
 * Imported only by the explicit outputs case. No remote/provider fallback. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runMedia, waitFor } from './cloud-managed-smoke.mjs'
import { requireLoopback } from './cloud-parity-contract.mjs'
import {
  outputsConfig,
  assessOutputProbe,
  assertOutputPixels
} from './cloud-parity-outputs-contract.mjs'
import { GRAPHICS_DRAW } from './cloud-parity-graphics-contract.mjs'
import { audioMeasurements, MEDIA } from './cloud-parity-media.mjs'

export async function exerciseOutputs({ h, report, webRoot, output, programUrl }) {
  const config = outputsConfig()
  requireLoopback(h.livekit.httpUrl)
  requireLoopback(programUrl)
  const requireWeb = createRequire(join(webRoot, 'package.json'))
  const sdk = requireWeb('livekit-server-sdk')
  const { build } = createRequire(requireWeb.resolve('tsx'))('esbuild')
  // Consume the real encoder builder from this exact web revision.
  const code = await build({
    stdin: {
      contents: "export {buildStartEgressRequest} from './lib/cloud/media/livekit-api'",
      resolveDir: webRoot
    },
    absWorkingDir: webRoot,
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    packages: 'external',
    alias: { '@': webRoot }
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code.outputFiles[0].text)(
    requireWeb,
    module,
    module.exports
  )
  const api = new sdk.EgressClient(h.livekit.httpUrl, h.livekit.apiKey, h.livekit.apiSecret)
  const result = {
    status: 'running',
    productionQualified: false,
    managed: 'not-run',
    higherProfiles: 'unqualified',
    price: 'unavailable',
    config,
    artifacts: [],
    phases: [],
    failures: []
  }
  report.outputs = result
  const save = () =>
    writeFileSync(
      join(output, 'outputs-acquisition.json'),
      JSON.stringify({ revisions: report.revisions, ...result }, null, 2) + '\n'
    )
  const started = Date.now()
  const remaining = () => {
    const ms = config.deadlineMs - (Date.now() - started)
    assert.ok(ms > 0, 'Outputs acquisition deadline exceeded')
    return Math.min(ms, 30000)
  }
  const artifact = (file, kind) => {
    const size = statSync(file).size
    assert.ok(size > 0 && size <= config.maxArtifactBytes, 'Artifact missing or over bound')
    const item = {
      file: relative(output, file),
      kind,
      bytes: size,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex')
    }
    result.artifacts.push(item)
    return item
  }
  let active, failure
  try {
    // The room reports what each output really sends: both orientations at
    // 1080p, a 30 fps picture in a 60 fps stream, 6 Mbps, no price, no 4K.
    const profile = (await h.rpc('cloud.status')).show?.outputProfile
    assert.deepEqual(
      profile?.effective.map((o) => [
        o.orientation,
        o.width,
        o.height,
        o.fps,
        o.pictureFps,
        o.videoKbps
      ]),
      [
        ['horizontal', 1920, 1080, 60, 30, 6000],
        ['vertical', 1080, 1920, 60, 30, 6000]
      ],
      'Room output profile'
    )
    assert.ok(
      profile.effective[1].differences.includes('resolution'),
      'A 720x1280 request says it is scaled'
    )
    assert.equal(profile.pricePerHour, null)
    assert.equal(profile.higherProfilesQualified, false)
    result.profile = profile
    assert.ok(h.speech, 'Local fake caption gateway unavailable')
    await h.rpc('cloud.recording.start')
    await h.status(
      (s) => s.recording?.active === true && !s.room?.live,
      'Independent record-only facts'
    )
    await h.eval(
      `const s=window.__videorcSmokeScenePresets,c=s.streamingState().captureConfig;s.configure({captions:{...c.captions,enabled:true,burnTarget:'both'}});return true`
    )
    await waitFor(
      () => h.speech.state.audioBytes > 0,
      'Actual host speech reaches local caption gateway',
      remaining()
    )
    for (const phase of ['both', 'recording-only', 'stream-only']) {
      const stream = phase !== 'recording-only',
        recording = phase !== 'stream-only'
      await h.rpc('banners.update', {
        id: report.graphics.patch,
        showOnStream: stream,
        showInRecording: recording
      })
      const layout = await h.rpc('overlays.layout.get')
      await h.rpc('overlays.layout.set', {
        ...layout,
        captions: { ...layout.captions, showOnStream: stream, showInRecording: recording }
      })
      for (const [orientation, outputKind, identity] of [
        ['h', 'stream', 'EG_parity_baseline'],
        ['v', 'stream', 'EG_parity_graphics_v'],
        ['h', 'recording', 'EG_parity_avatar_recording'],
        ['v', 'recording', 'EG_parity_graphics_vrec']
      ]) {
        const file = join(output, `${phase}-${orientation}-${outputKind}.mp4`)
        const url = new URL(programUrl)
        url.searchParams.set('layout', orientation)
        url.searchParams.set('token', h.web.tokenFor(h.showId, identity, 'recorder'))
        if (outputKind === 'recording') url.searchParams.set('rec', '1')
        else url.searchParams.delete('rec')
        const request = module.exports.buildStartEgressRequest({
          showId: h.showId,
          orientation,
          customBaseUrl: url.toString(),
          urls: null
        })
        assert.equal(request.encoding.case, 'advanced')
        // The local-only file sink replaces RTMP/storage; encoder settings and page
        // source are production. This cannot establish managed capacity or price.
        const info = await api.startWebEgress(
          url.toString(),
          new sdk.EncodedFileOutput({ filepath: file }),
          { encodingOptions: request.encoding.value, awaitStartSignal: false }
        )
        active = info.egressId
        await waitFor(
          async () => {
            const rows = await api.listEgress({ egressId: active })
            const state = rows.find((r) => r.egressId === active)?.status
            assert.ok(![3, 4, 5, 6].includes(state), 'Local egress terminated before acquisition')
            return state === 1
          },
          'Actual local encoder active',
          remaining()
        )
        const caption = await h.speech.emitRealtimeFinal('OUTPUT ORIENTATION CAPTION')
        void caption
        // Capture window only; readiness comes from the egress status above and
        // final pixels below. No clock alignment is inferred from this wait.
        await delay(config.seconds * 1000)
        const id = active
        await api.stopEgress(id)
        await waitFor(
          async () => {
            const rows = await api.listEgress({ egressId: id })
            const state = rows.find((r) => r.egressId === id)?.status
            assert.ok(![4, 5, 6].includes(state), 'Local encoder failed finalization')
            return state === 3
          },
          'Final local egress artifact',
          remaining()
        )
        active = null
        const encoded = artifact(file, 'actual-local-egress-h264-aac')
        const probe = JSON.parse(
          runMedia(h.ffprobe, [
            '-v',
            'error',
            '-count_frames',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            file
          ]).toString()
        )
        const checked = assessOutputProbe(probe, orientation, config.seconds)
        const probeFile = `${file}.ffprobe.json`
        writeFileSync(probeFile, JSON.stringify(probe, null, 2))
        artifact(probeFile, 'raw-ffprobe')
        assert.ok(checked.passed, `Final profile failed: ${JSON.stringify(checked.checks)}`)
        const width = orientation === 'h' ? 1920 : 1080,
          height = orientation === 'h' ? 1080 : 1920
        const rect = GRAPHICS_DRAW[orientation]
        const pixels = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          `fps=5,crop=8:8:${Math.floor((rect.x + rect.w / 6) * width)}:${Math.floor((rect.y + rect.h / 2) * height)},format=rgb24`,
          '-f',
          'rawvideo',
          'pipe:1'
        ])
        const visible = outputKind === 'stream' ? stream : recording
        const placement = assertOutputPixels(pixels, { expected: [0, 255, 255], absent: !visible })
        const raw = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '48000',
          '-f',
          'f32le',
          'pipe:1'
        ])
        const samples = new Float32Array(raw.length / 4)
        for (let i = 0; i < samples.length; i++) samples[i] = raw.readFloatLE(i * 4)
        const tones = audioMeasurements(samples)
        assert.ok(
          ['host', 'guest1', 'guest2'].every((k) => tones[k] > MEDIA.analysis.audibleDbfs),
          'Final encoded program missing a voice'
        )
        // Read the actual orientation-specific raster box; decode that ROI from
        // the finished file. Absence is also judged in pixels, not a receipt.
        const content = (await h.rpc('cloud.graphics.snapshot', { showId: h.showId })).content
        const layer = content?.[orientation]?.find((l) => l.kind === 'caption')
        assert.ok(layer, 'Caption measurement unavailable: no live raster/box')
        const r = layer.outputRects?.[outputKind] ?? layer.rect
        const glyphs = runMedia(h.ffmpeg, [
          '-v',
          'error',
          '-i',
          file,
          '-vf',
          `fps=5,crop=${Math.floor(r.w * width)}:${Math.floor(r.h * height)}:${Math.floor(r.x * width)}:${Math.floor(r.y * height)},format=rgb24`,
          '-f',
          'rawvideo',
          'pipe:1'
        ])
        let ink = 0
        for (let i = 0; i < glyphs.length; i += 3)
          if (glyphs[i] > 220 && glyphs[i + 1] > 220 && glyphs[i + 2] > 220) ink++
        assert.ok(visible ? ink > 30 : ink < 30, 'Final caption consent/placement failed')
        result.phases.push({
          phase,
          orientation,
          outputKind,
          encoded,
          checked,
          placement,
          captionInk: ink,
          tones
        })
        save()
      }
    }
    await h.rpc('cloud.recording.stop')
    result.status = 'passed'
  } catch (error) {
    result.status = 'failed'
    result.failures.push(
      'Output acquisition or final artifact qualification unavailable/failed; see parent redacted report'
    )
    failure = error
  } finally {
    if (active) {
      try {
        await api.stopEgress(active)
      } catch {
        result.failures.push('Local egress stop unconfirmed')
        failure ??= new Error('Local egress stop unconfirmed')
      }
    }
    save()
  }
  if (failure) throw failure
  return result
}
