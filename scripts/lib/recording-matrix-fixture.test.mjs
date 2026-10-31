import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { DEFAULT_GATES, evaluateGates } from './recording-analyzer.mjs'
import { prepareRecordingMatrixFixture, recordingMatrixGates } from './recording-matrix-fixture.mjs'

const ready = {
  wsStatus: 'connected',
  testPattern: true,
  screenId: null,
  windowId: null,
  layoutPreset: 'screen-only',
  committedLayoutPreset: 'screen-only',
  visualTransactionPending: false,
  layoutSwitchPending: null
}
const syntheticScene = { sources: [{ kind: 'test-pattern', visible: true }] }

function harness(states = [ready], scenes = [syntheticScene]) {
  let clock = 0
  let actionCount = 0
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
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      command: async (name, params, timeout) => {
        calls.push({ name, params, timeout })
        if (actionCount++ < 2) return { result: true }
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
