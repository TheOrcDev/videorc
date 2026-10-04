import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isFiller,
  parseMultipart,
  scriptedDrops,
  scriptedKeeps,
  startFakeTranscriptService,
  wordsForChunk
} from './fake-transcript-service.mjs'

const TOKEN = 'fake-clean-cut-session'

function pcm16Wav(seconds, amplitude = 0) {
  const sampleCount = Math.round(seconds * 16_000)
  const data = Buffer.alloc(sampleCount * 2)
  for (let index = 0; index < sampleCount; index += 1) {
    data.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

async function uploadChunk(fake, { index, startMs, seconds, token = TOKEN, language }) {
  const form = new FormData()
  form.append('sessionClientId', 'session-smoke')
  form.append('chunkIndex', String(index))
  form.append('chunkStartMs', String(startMs))
  if (language) form.append('language', language)
  form.append('audio', new Blob([pcm16Wav(seconds, 8_000)], { type: 'audio/wav' }), 'chunk.wav')
  const response = await fetch(`${fake.httpOrigin}/api/ai/transcripts/chunks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  })
  return { status: response.status, body: await response.json() }
}

const SCRIPT = [
  { text: 'So', startMs: 500, endMs: 700 },
  { text: 'um', startMs: 800, endMs: 1_100 },
  { text: 'today.', startMs: 1_200, endMs: 1_600 },
  { text: 'We', startMs: 2_000, endMs: 2_200, confidence: 0.97 },
  { text: 'build,', startMs: 2_300, endMs: 2_700 },
  { text: 'let', startMs: 3_000, endMs: 3_100 },
  { text: 'me', startMs: 3_100, endMs: 3_200 },
  { text: 'say', startMs: 3_200, endMs: 3_400 },
  { text: 'that', startMs: 3_400, endMs: 3_600 },
  { text: 'again.', startMs: 3_600, endMs: 4_000 },
  { text: 'We', startMs: 119_900, endMs: 120_100 },
  { text: 'ship.', startMs: 120_200, endMs: 120_600 }
]

describe('fake transcript service', () => {
  it('re-bases scripted words per chunk, tags fillers and splits sentences into drops', () => {
    const first = wordsForChunk(SCRIPT, 0, 120_000)
    assert.equal(
      first.length,
      10,
      'the word whose midpoint is exactly 120 s belongs to the next chunk'
    )
    assert.deepEqual(first[1], { text: 'um', startMs: 800, endMs: 1_100, filler: true })
    assert.deepEqual(first[3], { text: 'We', startMs: 2_000, endMs: 2_200, confidence: 0.97 })
    const second = wordsForChunk(SCRIPT, 119_000, 125_000)
    assert.deepEqual(
      second.map((word) => [word.text, word.startMs]),
      [
        ['We', 900],
        ['ship.', 1_200]
      ]
    )
    assert.ok(isFiller('Uh,') && isFiller('HMM') && !isFiller('umbrella'))

    const segments = [
      { id: 's1', text: 'So um today.' },
      { id: 's2', text: 'We build, let me say that again.' },
      { id: 's3', text: 'We ship.' }
    ]
    assert.deepEqual(scriptedDrops(segments), [
      {
        fromId: 's1',
        toId: 's1',
        kind: 'retake',
        confidence: 0.9,
        reason: 'Restarted the sentence; the later take is kept.'
      }
    ])
    assert.deepEqual(
      scriptedDrops(segments, {
        drops: [{ fromIndex: 2, kind: 'false_start', confidence: 0.4 }]
      })[1],
      { fromId: 's3', toId: 's3', kind: 'false_start', confidence: 0.4, reason: 'Scripted drop.' }
    )
    assert.deepEqual(scriptedKeeps(segments), [
      { fromId: 's1', toId: 's1', title: 'Intro' },
      { fromId: 's3', toId: 's3', title: 'Close' }
    ])
    assert.deepEqual(scriptedKeeps([]), [])
  })

  it('parses multipart bodies with text fields and a file', () => {
    const boundary = 'videorc-boundary'
    const body = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="chunkIndex"',
        '',
        '3',
        `--${boundary}`,
        'Content-Disposition: form-data; name="audio"; filename="chunk.wav"',
        'Content-Type: audio/wav',
        '',
        'RIFFdata',
        `--${boundary}--`,
        ''
      ].join('\r\n')
    )
    const parsed = parseMultipart(body, `multipart/form-data; boundary=${boundary}`)
    assert.equal(parsed.fields.get('chunkIndex'), '3')
    assert.equal(parsed.files.get('audio').filename, 'chunk.wav')
    assert.equal(parsed.files.get('audio').content.toString('ascii'), 'RIFFdata')
    assert.throws(() => parseMultipart(body, 'text/plain'))
  })

  it(
    'serves the chunk route with the contract codes and meters the allowance',
    { timeout: 15_000 },
    async () => {
      const fake = await startFakeTranscriptService({
        smokeSessionToken: TOKEN,
        words: SCRIPT,
        monthlySecondsLimit: 600,
        remainingSeconds: 10
      })
      try {
        const unauthorized = await uploadChunk(fake, {
          index: 0,
          startMs: 0,
          seconds: 1,
          token: 'nope'
        })
        assert.equal(unauthorized.status, 401)
        assert.equal(unauthorized.body.error.code, 'unauthorized')

        const ok = await uploadChunk(fake, { index: 0, startMs: 0, seconds: 5, language: 'en' })
        assert.equal(ok.status, 200)
        assert.equal(ok.body.chunkIndex, 0)
        assert.equal(ok.body.chunkSeconds, 5)
        assert.equal(ok.body.language, 'en')
        assert.equal(ok.body.words.length, 10)
        assert.equal(ok.body.words[1].filler, true)
        assert.equal(ok.body.text.startsWith('So um today.'), true)
        assert.equal(ok.body.remainingSeconds, 5)
        assert.equal(ok.body.monthlySecondsLimit, 600)
        assert.equal(fake.state.chunks[0].language, 'en')
        assert.equal(fake.state.chunks[0].sessionClientId, 'session-smoke')

        const exhausted = await uploadChunk(fake, { index: 1, startMs: 4_000, seconds: 6 })
        assert.equal(exhausted.status, 429)
        assert.equal(exhausted.body.error.code, 'clean-cut-monthly-quota-exhausted')
        assert.equal(fake.remainingSeconds, 5, 'a refused reservation is not taken')

        const tooLong = await uploadChunk(fake, { index: 2, startMs: 0, seconds: 121 })
        assert.equal(tooLong.status, 400)
        assert.equal(tooLong.body.error.code, 'invalid-transcript-chunk')

        fake.state.chunkFailureCode = 'clean-cut-disabled'
        const disabled = await uploadChunk(fake, { index: 3, startMs: 0, seconds: 1 })
        assert.equal(disabled.status, 503)
        assert.equal(disabled.body.error.code, 'clean-cut-disabled')
        fake.state.chunkFailureCode = null

        const capabilities = await (
          await fetch(`${fake.httpOrigin}/api/ai/capabilities`, {
            headers: { authorization: `Bearer ${TOKEN}` }
          })
        ).json()
        assert.equal(capabilities.features.cleanCutEnabled, true)
        assert.equal(capabilities.cleanCut.available, true)
        assert.equal(capabilities.cleanCut.remainingSeconds, 5)
        assert.deepEqual(capabilities.cleanCut.modes, ['clean', 'condensed'])
        assert.equal(capabilities.cleanCut.workflowKind, 'post-recording-clean-cut')
        // Plan 140 S9: Orcle's cloud command parser is off unless a smoke opts in.
        assert.equal(capabilities.features.cohostCommandEnabled, false)
        assert.equal(capabilities.limits.dailyCommandCalls, 300)
        fake.state.cohostCommandEnabled = true
        const enabled = await (
          await fetch(`${fake.httpOrigin}/api/ai/capabilities`, {
            headers: { authorization: `Bearer ${TOKEN}` }
          })
        ).json()
        assert.equal(enabled.features.cohostCommandEnabled, true)
        assert.equal(fake.state.chunkRequests, 3, 'an invalid chunk is refused before it counts')
      } finally {
        await fake.close()
      }
    }
  )

  it('serves the words set after start to every later chunk', { timeout: 15_000 }, async () => {
    const fake = await startFakeTranscriptService({ smokeSessionToken: TOKEN })
    try {
      const before = await uploadChunk(fake, { index: 0, startMs: 0, seconds: 5 })
      assert.equal(before.status, 200)
      assert.deepEqual(before.body.words, [], 'no words were scripted yet')

      fake.setWords(SCRIPT)
      const after = await uploadChunk(fake, { index: 0, startMs: 0, seconds: 5 })
      assert.equal(after.status, 200)
      assert.equal(after.body.words.length, 10)
      assert.deepEqual(after.body.words[1], {
        text: 'um',
        startMs: 800,
        endMs: 1_100,
        filler: true
      })

      fake.setWords(null)
      const cleared = await uploadChunk(fake, { index: 0, startMs: 0, seconds: 5 })
      assert.deepEqual(cleared.body.words, [], 'anything but an array clears the script')
    } finally {
      await fake.close()
    }
  })

  it('runs the analysis job deterministically through queued, running and completed', async () => {
    const fake = await startFakeTranscriptService({ smokeSessionToken: TOKEN, words: SCRIPT })
    const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
    const segments = [
      { id: 's1', startMs: 500, endMs: 1_600, text: 'So um today.' },
      { id: 's2', startMs: 2_000, endMs: 4_000, text: 'We build, let me say that again.' },
      { id: 's3', startMs: 119_900, endMs: 120_600, text: 'We ship.' }
    ]
    const body = (overrides = {}) =>
      JSON.stringify({
        sessionClientId: 'session-smoke',
        workflowKind: 'post-recording-clean-cut',
        clientRequestId: 'cleancut:session-smoke:clean:0123456789abcdef',
        clientVersion: 'videorc-desktop/test',
        consentToUploadAudio: true,
        inputJson: { mode: 'clean', durationMs: 1_500_000, language: 'en', segments },
        ...overrides
      })
    try {
      const noConsent = await fetch(`${fake.httpOrigin}/api/ai/jobs`, {
        method: 'POST',
        headers,
        body: body({ consentToUploadAudio: false })
      })
      assert.equal(noConsent.status, 400)
      assert.equal((await noConsent.json()).error.code, 'invalid-ai-job')

      const created = await fetch(`${fake.httpOrigin}/api/ai/jobs`, {
        method: 'POST',
        headers,
        body: body()
      })
      assert.equal(created.status, 200)
      const createdBody = await created.json()
      assert.equal(createdBody.idempotent, false)
      assert.equal(createdBody.job.status, 'queued')
      assert.equal(createdBody.job.workflowKind, 'post-recording-clean-cut')
      assert.equal(createdBody.job.artifacts.cleanCut, undefined)

      const again = await (
        await fetch(`${fake.httpOrigin}/api/ai/jobs`, { method: 'POST', headers, body: body() })
      ).json()
      assert.equal(again.idempotent, true)
      assert.equal(again.job.id, createdBody.job.id)

      const poll = async () =>
        (
          await fetch(`${fake.httpOrigin}/api/ai/jobs/${createdBody.job.id}`, {
            headers: { authorization: `Bearer ${TOKEN}` }
          })
        ).json()
      const running = (await poll()).job
      assert.equal(running.status, 'running')
      assert.deepEqual(running.artifacts.cleanCutProgress, { windows: { total: 3, completed: 2 } })
      assert.equal(running.artifacts.cleanCut, undefined)
      const requeued = (await poll()).job
      assert.equal(requeued.status, 'queued', 'running may go back to queued and resume by itself')
      const completed = (await poll()).job
      assert.equal(completed.status, 'completed')
      assert.equal(completed.artifacts.cleanCutProgress, undefined)
      assert.deepEqual(completed.artifacts.cleanCut, {
        mode: 'clean',
        drops: [
          {
            fromId: 's1',
            toId: 's1',
            kind: 'retake',
            confidence: 0.9,
            reason: 'Restarted the sentence; the later take is kept.'
          }
        ],
        windows: { total: 3, completed: 3 }
      })
      assert.equal(fake.state.jobs.get(createdBody.job.id).input.segmentCount, 3)
      assert.equal(fake.state.jobs.get(createdBody.job.id).input.segments, undefined)

      const condensed = await (
        await fetch(`${fake.httpOrigin}/api/ai/jobs`, {
          method: 'POST',
          headers,
          body: body({
            clientRequestId: 'cleancut:session-smoke:condensed:0123456789abcdef',
            inputJson: {
              mode: 'condensed',
              durationMs: 120_000,
              language: 'en',
              segments,
              targetDurationSeconds: 120,
              mustKeep: [{ fromId: 's3', toId: 's3', reason: 'clip-mark' }]
            }
          })
        })
      ).json()
      const condensedPoll = async () =>
        (
          await fetch(`${fake.httpOrigin}/api/ai/jobs/${condensed.job.id}`, {
            headers: { authorization: `Bearer ${TOKEN}` }
          })
        ).json()
      await condensedPoll()
      const condensedDone = (await condensedPoll()).job
      assert.equal(condensedDone.status, 'completed', 'a one-window job never requeues')
      assert.deepEqual(condensedDone.artifacts.cleanCut.keeps, [
        { fromId: 's1', toId: 's1', title: 'Intro' },
        { fromId: 's3', toId: 's3', title: 'Close' }
      ])
      assert.equal(condensedDone.artifacts.cleanCut.beats.length, 2)
      assert.equal(condensedDone.artifacts.cleanCut.beats[0].hook, true)
      assert.equal(fake.state.jobs.get(condensed.job.id).input.mustKeepCount, 1)

      fake.state.jobFailureCode = 'clean-cut-daily-quota-exhausted'
      const blocked = await fetch(`${fake.httpOrigin}/api/ai/jobs`, {
        method: 'POST',
        headers,
        body: body({ clientRequestId: 'cleancut:session-smoke:clean:fedcba9876543210' })
      })
      assert.equal(blocked.status, 429)
      assert.equal((await blocked.json()).error.code, 'clean-cut-daily-quota-exhausted')
      const missing = await fetch(`${fake.httpOrigin}/api/ai/jobs/nope`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      assert.equal(missing.status, 404)
    } finally {
      await fake.close()
    }
  })
})
