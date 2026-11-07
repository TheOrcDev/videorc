import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'

import { DEFAULT_GATES, evaluateGates } from './recording-analyzer.mjs'
import {
  assessRecordingMatrixTone,
  prepareRecordingMatrixFixture,
  recordingMatrixGates,
  withRecordingMatrixAudio
} from './recording-matrix-fixture.mjs'

const ready = {
  wsStatus: 'connected',
  testPattern: true,
  screenId: null,
  windowId: null,
  layoutPreset: 'screen-only',
  committedLayoutPreset: 'screen-only',
  visualTransactionPending: false,
  layoutSwitchPending: null,
  microphoneSwitchReason: null
}
const syntheticScene = { sources: [{ kind: 'test-pattern', visible: true }] }

function harness(states = [ready], scenes = [syntheticScene], microphoneId) {
  let clock = 0
  let stateReads = 0
  let sceneReads = 0
  const calls = []
  return {
    calls,
    get stateReads() {
      return stateReads
    },
    get sceneReads() {
      return sceneReads
    },
    options: {
      timeoutMs: 500,
      microphoneId,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      command: async (name, params, timeout) => {
        calls.push({ name, params, timeout })
        if (name === 'enable-synthetic-source' || params.code.includes('const scenes ='))
          return { result: true }
        return { result: states[Math.min(stateReads++, states.length - 1)] }
      },
      request: async (method) => {
        assert.equal(method, 'scene.get')
        return scenes[Math.min(sceneReads++, scenes.length - 1)]
      }
    }
  }
}

describe('recording matrix synthetic source ownership', () => {
  const microphoneId = 'microphone:linux-pulse:6f776e6564'
  const audioReady = { ...ready, microphoneId, microphoneMuted: false, microphoneGainDb: 0 }

  it('waits for scene and source-switch readiness before selecting the microphone once', async () => {
    const run = harness(
      [
        { ...ready, visualTransactionPending: true },
        { ...ready, microphoneSwitchReason: 'The session is starting.' },
        ready,
        audioReady
      ],
      [syntheticScene],
      microphoneId
    )
    await prepareRecordingMatrixFixture(run.options)
    const switches = run.calls.filter((call) => call.params?.code?.includes('await scenes.source'))
    assert.equal(switches.length, 1)
    assert.equal(run.calls.indexOf(switches[0]), 5)
    assert.equal(run.stateReads, 4)
  })

  it('waits for the owned microphone selection and explicit unmuted unity gain', async () => {
    const run = harness(
      [ready, { ...audioReady, microphoneMuted: true }, audioReady],
      [syntheticScene],
      microphoneId
    )
    const result = await prepareRecordingMatrixFixture(run.options)
    assert.equal(result.microphoneId, microphoneId)
    assert.equal(run.stateReads, 3)
    assert.equal(run.sceneReads, 1)
    assert.match(
      run.calls.find((call) => call.params?.code?.includes('await scenes.source')).params.code,
      /scenes\.configure/
    )
    assert.ok(
      run.calls
        .find((call) => call.params?.code?.includes('await scenes.source'))
        .params.code.includes(JSON.stringify(microphoneId))
    )
  })

  it('awaits the source owner before applying audio without overwriting its selection', async () => {
    const run = harness([audioReady], [syntheticScene], microphoneId)
    await prepareRecordingMatrixFixture(run.options)
    const calls = []
    let finishSwitch
    const switched = new Promise((resolve) => (finishSwitch = resolve))
    const scenes = {
      streamingState: () => ({
        captureConfig: {
          sources: { testPattern: true, microphoneId: 'previous', microphoneName: 'Previous' },
          audio: { microphoneMuted: true, microphoneGainDb: -10, systemAudioEnabled: false }
        }
      }),
      source: async (kind, sources) => {
        assert.equal(kind, 'microphone')
        assert.equal(sources.microphoneId, microphoneId)
        assert.equal(sources.microphoneName, undefined)
        assert.equal(sources.microphoneOff, undefined)
        assert.equal(sources.testPattern, true)
        calls.push('switch')
        await switched
        calls.push('confirmed')
      },
      configure: (patch) => {
        assert.deepEqual(calls, ['switch', 'confirmed'])
        assert.equal('sources' in patch, false, "keep the source owner's confirmed selection")
        assert.equal(patch.audio.microphoneMuted, false)
        assert.equal(patch.audio.microphoneGainDb, 0)
        assert.equal(patch.audio.systemAudioEnabled, false)
        calls.push('audio')
      }
    }
    const applied = runInNewContext(
      `(async () => { ${run.calls.find((call) => call.params?.code?.includes('await scenes.source')).params.code} })()`,
      {
        window: { __videorcSmokeScenePresets: scenes }
      }
    )
    assert.deepEqual(calls, ['switch'])
    finishSwitch()
    assert.equal(await applied, true)
    assert.deepEqual(calls, ['switch', 'confirmed', 'audio'])
  })

  for (const patch of [
    { microphoneId: 'microphone:other' },
    { microphoneMuted: true },
    { microphoneGainDb: -60 }
  ]) {
    it(`refuses an uncommitted audio fixture: ${JSON.stringify(patch)}`, async () => {
      const run = harness([{ ...audioReady, ...patch }], [syntheticScene], microphoneId)
      await assert.rejects(prepareRecordingMatrixFixture(run.options), /did not commit/)
      assert.equal(run.sceneReads, 0)
    })
  }

  it('selects through renderer actions and waits out the stale scene and pending transaction', async () => {
    const run = harness(
      [
        { ...ready, testPattern: false, screenId: 'screen:portal' },
        { ...ready, visualTransactionPending: true },
        ready
      ],
      [{ sources: [...syntheticScene.sources, { kind: 'camera', visible: true }] }, syntheticScene]
    )
    assert.deepEqual(await prepareRecordingMatrixFixture(run.options), {
      layoutPreset: 'screen-only',
      visibleSourceKinds: ['test-pattern']
    })
    assert.equal(run.calls[0].name, 'enable-synthetic-source')
    assert.match(run.calls[1].params.code, /scenes\.layout\(/)
    assert.equal(run.stateReads, 4)
    assert.equal(run.sceneReads, 2)
  })

  for (const patch of [
    { wsStatus: 'connecting' },
    { testPattern: false },
    { screenId: 'screen:portal' },
    { windowId: 'window:portal' },
    { layoutPreset: 'screen-camera' },
    { committedLayoutPreset: 'screen-camera' },
    { visualTransactionPending: true },
    { layoutSwitchPending: 'screen-only' }
  ]) {
    it(`refuses a stale renderer within the deadline: ${JSON.stringify(patch)}`, async () => {
      const run = harness([{ ...ready, ...patch }])
      await assert.rejects(prepareRecordingMatrixFixture(run.options), /did not commit/)
      assert.equal(run.sceneReads, 0)
      assert.equal(run.stateReads, 5)
    })
  }

  for (const scene of [null, { sources: [] }, { sources: [{ kind: 'screen', visible: true }] }]) {
    it(`refuses missing synthetic backend evidence: ${JSON.stringify(scene)}`, async () => {
      const run = harness([ready], [scene])
      await assert.rejects(prepareRecordingMatrixFixture(run.options), /did not commit/)
      assert.equal(run.sceneReads, 5)
    })
  }

  it('propagates a source action refusal without falling back to backend-only selection', async () => {
    const run = harness()
    run.options.command = async () => {
      throw new Error('source transition refused')
    }
    await assert.rejects(prepareRecordingMatrixFixture(run.options), /source transition refused/)
    assert.equal(run.sceneReads, 0)
  })

  it('does not start a layout mutation after source selection exhausted the deadline', async () => {
    const run = harness()
    const command = run.options.command
    run.options.command = async (...args) => {
      const result = await command(...args)
      await run.options.sleep(500)
      return result
    }
    await assert.rejects(prepareRecordingMatrixFixture(run.options), /apply screen-only layout/)
    assert.equal(run.calls.length, 1)
    assert.equal(run.sceneReads, 0)
  })

  it('retains the last pending renderer state when the next read times out', async () => {
    const run = harness([{ ...ready, visualTransactionPending: true }])
    const command = run.options.command
    const timeout = new Error('eval-js smoke command timed out after 1ms')
    run.options.command = async (...args) => {
      if (run.stateReads === 1) throw timeout
      return command(...args)
    }
    await assert.rejects(prepareRecordingMatrixFixture(run.options), (error) => {
      assert.match(error.message, /confirm renderer and backend scene/)
      assert.match(error.message, /"visualTransactionPending":true/)
      assert.equal(error.cause, timeout)
      return true
    })
    assert.equal(run.calls.filter((call) => call.name === 'enable-synthetic-source').length, 1)
    assert.equal(run.sceneReads, 0)
  })
})

describe('recording matrix controlled Linux audio', () => {
  it('keeps the fixture alive through the whole pass and cleans it up after a failure', async () => {
    const calls = []
    const source = { frequency: 440, deviceId: 'microphone:linux-pulse:6f776e6564' }
    const failure = new Error('artifact failed')
    await assert.rejects(
      withRecordingMatrixAudio({
        platform: 'linux',
        ffmpegPath: '/bundled/ffmpeg',
        acquireLock: async () => calls.push('lock'),
        startFixtures: async ({ ffmpegPath, otherFrequency }) => {
          assert.equal(ffmpegPath, '/bundled/ffmpeg')
          assert.equal(otherFrequency, 997)
          calls.push('start')
          return { sources: [source], stop: async () => calls.push('stop') }
        },
        run: async (microphoneId) => {
          assert.equal(microphoneId, source.deviceId)
          assert.deepEqual(calls, ['lock', 'start'])
          calls.push('record')
          throw failure
        }
      }),
      (error) => error === failure
    )
    assert.deepEqual(calls, ['lock', 'start', 'record', 'stop'])
  })

  it('refuses a missing fixture and still removes its modules', async () => {
    let stopped = false
    await assert.rejects(
      withRecordingMatrixAudio({
        platform: 'linux',
        acquireLock: async () => {},
        startFixtures: async () => ({
          sources: [],
          stop: async () => {
            stopped = true
          }
        }),
        run: async () => assert.fail('cannot record with a missing input')
      }),
      /owned 440 Hz/
    )
    assert.equal(stopped, true)
  })

  it('does not load Pulse fixtures on the other platforms', async () => {
    for (const platform of ['darwin', 'win32']) {
      assert.equal(
        await withRecordingMatrixAudio({
          platform,
          acquireLock: async () => assert.fail('unexpected fixture lock'),
          startFixtures: async () => assert.fail('unexpected Pulse fixture'),
          run: async (microphoneId) => {
            assert.equal(microphoneId, undefined)
            return 'native'
          }
        }),
        'native'
      )
    }
  })

  const signal = (...frequencies) =>
    Float32Array.from({ length: 96_000 }, (_, i) =>
      frequencies.reduce(
        (value, frequency) => value + 0.1 * Math.sin((2 * Math.PI * frequency * i) / 48_000),
        0
      )
    )
  it('identifies the selected tone and rejects silence, a wrong input and a mixed sink', () => {
    assert.deepEqual(assessRecordingMatrixTone(signal(440)).failures, [])
    assert.deepEqual(assessRecordingMatrixTone(signal(440, 880)).failures, [])
    for (const samples of [signal(), signal(997), signal(440, 997), new Float32Array()]) {
      assert.ok(assessRecordingMatrixTone(samples).failures.length > 0)
    }
  })
})

describe('recording matrix moving-content gates', () => {
  const gates = { ...DEFAULT_GATES, ...recordingMatrixGates(6000) }
  const clean = {
    hasVideo: true,
    hasAudio: true,
    expectAudio: true,
    width: 1920,
    height: 1080,
    intendedFps: 30,
    level: 40,
    colorSpace: 'bt709',
    colorPrimaries: 'bt709',
    colorTransfer: 'bt709',
    colorRange: 'tv',
    durationSeconds: 6,
    expectedFrames: 180,
    observedFrames: 180,
    longestCorroboratedFreezeMs: 0,
    maxRepeatedFrameRun: 1,
    keyframeCount: 3,
    maxKeyframeIntervalSeconds: 2,
    tailMismatchMs: 8
  }
  it('passes the clean moving fixture', () => {
    assert.equal(evaluateGates(clean, gates).pass, true)
  })
  it('fails duplicated content even when CFR timing and frame count are correct', () => {
    const verdict = evaluateGates(
      {
        ...clean,
        longestCorroboratedFreezeMs: 267,
        corroboratedFreezeCount: 1,
        maxRepeatedFrameRun: 7,
        repeatedBurstCount: 1
      },
      gates
    )
    assert.equal(verdict.pass, false)
    assert.equal(verdict.failures.length, 2)
    assert.match(verdict.failures.join('\n'), /freeze segment 267ms/)
    assert.match(verdict.failures.join('\n'), /7 consecutive identical frames/)
  })
  it('retains duration, audio-gap, stop-tail and GOP requirements', () => {
    for (const [patch, message] of [
      [{ durationSeconds: 5.8 }, /requested minimum/],
      [{ maxAudioGapMs: 21 }, /audio PTS gap/],
      [{ tailMismatchMs: 101 }, /tail mismatch/],
      [{ maxKeyframeIntervalSeconds: 2.6 }, /keyframe interval/],
      [{ observedFrames: 175 }, /frame count/]
    ]) {
      const verdict = evaluateGates({ ...clean, ...patch }, gates)
      assert.equal(verdict.pass, false)
      assert.match(verdict.failures.join('\n'), message)
    }
  })
})
