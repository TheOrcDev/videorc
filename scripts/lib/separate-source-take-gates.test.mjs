import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ROLE_AUDIO_TITLES,
  audioStreamTitle,
  evaluateTake,
  summarizeRoleProbe,
  takeSiblingPaths
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
