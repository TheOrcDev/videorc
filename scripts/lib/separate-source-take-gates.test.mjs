import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ROLE_AUDIO_TITLES,
  audioStreamTitle,
  evaluateRoleAudioSources,
  evaluateTake,
  summarizeRoleProbe,
  takeSiblingPaths,
  toneAmplitude
} from './separate-source-take-gates.mjs'

function probe(role, overrides = {}) {
  const {
    duration = 12.04,
    width = 1920,
    height = 1080,
    fps = '30/1',
    channels = 2,
    title = ROLE_AUDIO_TITLES[role],
    titleTag = 'title',
    audioStreams = 1,
    videoStreams = 1
  } = overrides
  const streams = []
  for (let index = 0; index < videoStreams; index += 1) {
    streams.push({ codec_type: 'video', codec_name: 'h264', width, height, r_frame_rate: fps })
  }
  for (let index = 0; index < audioStreams; index += 1) {
    const tags = title == null ? {} : { [titleTag]: title }
    streams.push({ codec_type: 'audio', codec_name: 'pcm_s16le', channels, tags })
  }
  return { format: { duration: String(duration) }, streams }
}

function take(overrides = {}) {
  return {
    combined: summarizeRoleProbe(probe('combined', overrides.combined)),
    screen: summarizeRoleProbe(probe('screen', overrides.screen)),
    camera: summarizeRoleProbe(probe('camera', overrides.camera))
  }
}

const canvas = { width: 1920, height: 1080, fps: 30 }

describe('takeSiblingPaths', () => {
  it('keeps the Combined name and inserts the role before the extension', () => {
    const paths = takeSiblingPaths('/rec/videorc-session-20261006-120000-abc.mkv')
    assert.equal(paths.combined, '/rec/videorc-session-20261006-120000-abc.mkv')
    assert.equal(paths.screen, '/rec/videorc-session-20261006-120000-abc-screen.mkv')
    assert.equal(paths.camera, '/rec/videorc-session-20261006-120000-abc-camera.mkv')
    assert.equal(takeSiblingPaths('/rec/take.mp4').camera, '/rec/take-camera.mp4')
    assert.equal(
      takeSiblingPaths('C:\\Videos\\take.mkv').screen,
      'C:\\Videos\\take-screen.mkv',
      'Windows separators are preserved as given'
    )
    assert.equal(takeSiblingPaths('take').camera, 'take-camera')
    assert.equal(
      takeSiblingPaths('C:\\Videos\\archive.dir\\take').screen,
      'C:\\Videos\\archive.dir\\take-screen',
      'a dotted Windows directory is never read as the extension, on any host'
    )
  })
})

describe('audioStreamTitle', () => {
  it('reads the MKV title or the MP4 handler name', () => {
    assert.equal(audioStreamTitle({ tags: { title: 'Microphone' } }), 'Microphone')
    assert.equal(audioStreamTitle({ tags: { handler_name: 'System audio' } }), 'System audio')
    assert.equal(audioStreamTitle({ tags: {} }), null)
    assert.equal(audioStreamTitle(undefined), null)
  })
})

describe('evaluateTake', () => {
  it('requires explicit source removal intervals for shorter files and rejects truncation', () => {
    const shorter = take({ camera: { duration: 3 } })
    assert.equal(evaluateTake(shorter, { video: canvas }).pass, false)
    const interval = { outcome: 'source-removed', startSeconds: 0, endSeconds: 3 }
    assert.equal(
      evaluateTake(shorter, { video: canvas, intervals: { camera: interval } }).pass,
      true
    )
    for (const changed of [
      { ...interval, outcome: 'completed' },
      { ...interval, startSeconds: 1 },
      { ...interval, endSeconds: 0 },
      { ...interval, endSeconds: 5 }
    ])
      assert.equal(
        evaluateTake(shorter, { video: canvas, intervals: { camera: changed } }).pass,
        false
      )
  })

  it('passes a healthy three-role take', () => {
    const result = evaluateTake(take(), { video: canvas })
    assert.deepEqual(result, { pass: true, failures: [], warnings: [] })
  })

  it('accepts MP4 handler names for the role titles', () => {
    const result = evaluateTake(
      take({
        combined: { titleTag: 'handler_name' },
        screen: { titleTag: 'handler_name' },
        camera: { titleTag: 'handler_name' }
      }),
      { video: canvas }
    )
    assert.equal(result.pass, true, result.failures.join('; '))
  })

  it('fails a missing role file', () => {
    const summaries = take()
    summaries.camera = null
    const result = evaluateTake(summaries, { video: canvas })
    assert.equal(result.pass, false)
    assert.deepEqual(result.failures, ['camera file is missing from the take'])
  })

  it('calls out swapped audio pairing by name', () => {
    const result = evaluateTake(
      take({ screen: { title: 'Microphone' }, camera: { title: 'System audio' } }),
      { video: canvas }
    )
    assert.equal(result.pass, false)
    assert.match(result.failures[0], /screen file carries the camera audio track/)
    assert.match(result.failures[1], /camera file carries the screen audio track/)
  })

  it('fails an untitled track unless titles are optional', () => {
    const summaries = take({ screen: { title: null } })
    assert.equal(evaluateTake(summaries, { video: canvas }).pass, false)
    const relaxed = evaluateTake(summaries, { video: canvas }, { requireAudioTitles: false })
    assert.equal(relaxed.pass, true)
    assert.equal(relaxed.warnings.length, 1)
  })

  it('fails an ISO file that is not on the recording canvas', () => {
    const result = evaluateTake(take({ camera: { width: 1280, height: 720 } }), { video: canvas })
    assert.equal(result.pass, false)
    assert.match(result.failures[0], /camera video is 1280x720/)
  })

  it('fails extra or missing streams and mono audio', () => {
    const result = evaluateTake(
      take({
        combined: { audioStreams: 2 },
        screen: { videoStreams: 0 },
        camera: { channels: 1 }
      }),
      { video: canvas }
    )
    assert.equal(result.pass, false)
    assert.ok(result.failures.some((line) => /combined file has 2 audio streams/.test(line)))
    assert.ok(result.failures.some((line) => /screen file has 0 video streams/.test(line)))
    assert.ok(result.failures.some((line) => /camera audio has 1 channels/.test(line)))
  })

  it('fails when the files drift apart in duration and warns near the limit', () => {
    const drifted = evaluateTake(take({ camera: { duration: 9.5 } }), { video: canvas })
    assert.equal(drifted.pass, false)
    assert.match(drifted.failures[0], /differ in duration by 2\.54s/)
    const close = evaluateTake(take({ camera: { duration: 11.3 } }), { video: canvas })
    assert.equal(close.pass, true)
    assert.equal(close.warnings.length, 1)
  })

  it('judges only the roles the session armed', () => {
    const summaries = take()
    summaries.combined = null
    const result = evaluateTake(summaries, { roles: ['screen', 'camera'], video: canvas })
    assert.equal(result.pass, true, result.failures.join('; '))
    assert.equal(evaluateTake(summaries, { roles: ['stream'] }).pass, false)
  })
})

function stereoTones(tones, frames = 48000) {
  const samples = new Float32Array(frames * 2)
  for (let frame = 0; frame < frames; frame += 1) {
    let left = 0
    let right = 0
    for (const { frequency, amplitude, rightScale = 1 } of tones) {
      const value = amplitude * Math.sin((2 * Math.PI * frequency * frame) / 48000)
      left += value
      right += value * rightScale
    }
    samples[frame * 2] = left
    samples[frame * 2 + 1] = right
  }
  return samples
}

describe('toneAmplitude', () => {
  it('reads a whole-cycle tone at its peak and another tone at zero', () => {
    const samples = stereoTones([
      { frequency: 440, amplitude: 0.5 },
      { frequency: 1000, amplitude: 0.3, rightScale: 0.5 }
    ])
    assert.ok(Math.abs(toneAmplitude(samples, { frequency: 440 }) - 0.5) < 1e-4)
    assert.ok(Math.abs(toneAmplitude(samples, { frequency: 1000 }) - 0.3) < 1e-4)
    assert.ok(Math.abs(toneAmplitude(samples, { frequency: 1000, channel: 1 }) - 0.15) < 1e-4)
    assert.ok(
      toneAmplitude(stereoTones([{ frequency: 440, amplitude: 0.5 }]), { frequency: 1000 }) < 1e-4
    )
    assert.equal(toneAmplitude(new Float32Array(0), { frequency: 440 }), 0)
  })
})

describe('evaluateRoleAudioSources', () => {
  const expected = { microphone: 0.5, system: 0.3 }
  const healthy = {
    combined: { microphone: 0.49, system: 0.31 },
    screen: { microphone: 0.001, system: 0.29 },
    camera: { microphone: 0.51, system: 0.002 }
  }

  it('passes when each role carries exactly its sources', () => {
    assert.deepEqual(evaluateRoleAudioSources(healthy, expected), { pass: true, failures: [] })
  })

  it('names swapped samples even when the titles were right', () => {
    const result = evaluateRoleAudioSources(
      { ...healthy, screen: healthy.camera, camera: healthy.screen },
      expected
    )
    assert.equal(result.pass, false)
    assert.deepEqual(result.failures, [
      'screen file carries the camera audio samples (microphone); the pairing is swapped',
      'camera file carries the screen audio samples (system); the pairing is swapped'
    ])
  })

  it('fails a missing ingredient, a leak, and an unmeasured role', () => {
    const result = evaluateRoleAudioSources(
      {
        combined: { microphone: 0.5, system: 0 },
        screen: { microphone: 0.2, system: 0.3 },
        camera: null
      },
      expected
    )
    assert.equal(result.pass, false)
    assert.deepEqual(result.failures, [
      'combined audio lacks the system (amplitude 0.000, expected 0.3)',
      'screen audio carries the microphone (amplitude 0.200); it must hold system only',
      'camera audio was not measured'
    ])
  })

  it('judges only the roles asked for', () => {
    const result = evaluateRoleAudioSources({ screen: healthy.screen }, expected, {
      roles: ['screen']
    })
    assert.equal(result.pass, true, result.failures.join('; '))
  })
})
