import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  INCIDENT_FFMPEG_TONE_EVENT,
  incidentToneMissingFailure,
  releaseBackendIncidentToneRefusal
} from './incident-ffmpeg-tone.mjs'

const tone = { VIDEORC_INCIDENT_FFMPEG_TONE: '1' }

test('the incident tone refuses the release dev backend, which silently drops it', () => {
  const refusal = releaseBackendIncidentToneRefusal(tone, {
    VIDEORC_DEV_BACKEND_PROFILE: 'release'
  })
  assert.match(refusal, /VIDEORC_INCIDENT_FFMPEG_TONE only works with the debug backend/)
  assert.match(refusal, /Unset VIDEORC_DEV_BACKEND_PROFILE/)
  // The launch env wins over the shell, for both names.
  assert.match(
    releaseBackendIncidentToneRefusal({ ...tone, VIDEORC_DEV_BACKEND_PROFILE: 'release' }, {}),
    /debug backend/
  )
  assert.match(
    releaseBackendIncidentToneRefusal(
      {},
      { VIDEORC_DEV_BACKEND_PROFILE: 'release', VIDEORC_INCIDENT_FFMPEG_TONE: '1' }
    ),
    /debug backend/
  )
  assert.equal(
    releaseBackendIncidentToneRefusal(
      { ...tone, VIDEORC_DEV_BACKEND_PROFILE: 'debug' },
      { VIDEORC_DEV_BACKEND_PROFILE: 'release' }
    ),
    null
  )
  // Debug backend, or no tone asked for: launch as before.
  assert.equal(releaseBackendIncidentToneRefusal(tone, {}), null)
  assert.equal(
    releaseBackendIncidentToneRefusal(tone, { VIDEORC_DEV_BACKEND_PROFILE: 'debug' }),
    null
  )
  assert.equal(
    releaseBackendIncidentToneRefusal(
      { VIDEORC_INCIDENT_FFMPEG_TONE: '0' },
      { VIDEORC_DEV_BACKEND_PROFILE: 'release' }
    ),
    null
  )
  assert.equal(
    releaseBackendIncidentToneRefusal({}, { VIDEORC_DEV_BACKEND_PROFILE: 'release' }),
    null
  )
})

test('a session without the tone health event is named, not left to the audio gates', () => {
  assert.equal(INCIDENT_FFMPEG_TONE_EVENT, 'incident-ffmpeg-tone-enabled')
  assert.equal(
    incidentToneMissingFailure({
      events: [{ code: 'recording-start-timeline' }, { code: INCIDENT_FFMPEG_TONE_EVENT }]
    }),
    null
  )
  for (const page of [
    { events: [{ code: 'recording-start-timeline' }] },
    { events: [] },
    {},
    null
  ]) {
    assert.match(
      incidentToneMissingFailure(page),
      /no incident-ffmpeg-tone-enabled health event, so it carries silence/
    )
  }
})

test('the recording matrix refuses a release backend before launch and checks the tone event', () => {
  const smoke = readFileSync(
    resolve(import.meta.dirname, '..', 'smoke-recording-matrix-app.mjs'),
    'utf8'
  )
  assert.match(smoke, /VIDEORC_INCIDENT_FFMPEG_TONE: '1'/)
  const refusal = smoke.indexOf('releaseBackendIncidentToneRefusal({')
  assert.ok(refusal > 0, 'the matrix calls the release-backend refusal')
  assert.ok(refusal < smoke.indexOf('mkdtempSync('), 'the refusal runs before any setup')
  assert.match(
    smoke,
    /Recording matrix BLOCKED: \$\{incidentToneRefusal\}`\)\n\s+process\.exit\(2\)/
  )
  assert.match(
    smoke,
    /incidentToneMissingFailure\(\s*await request\(ws, timeoutMs, 'sessions\.healthEvents\.list'/
  )
})
