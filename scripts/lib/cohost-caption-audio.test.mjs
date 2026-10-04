import assert from 'node:assert/strict'
import { it } from 'node:test'

import { startCaptionAudioPump, streamSessionParams } from './cohost-caption-audio.mjs'

function bounded(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded its owned deadline.`)),
      1_000
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

// Exercise the maintained pump's actual request and timer owners. Interval
// callbacks are explicit readiness boundaries; no wall-clock settle or backend
// model manufactures the selected method. Every captured request is completed
// and every builtin restored before an assertion can fail.
async function observePump(t, { previousProgress = false, streamSessionId, refuse = false } = {}) {
  const ws = { owner: 'confirmed-caption-admin' }
  const captionFake = { state: { realtimePartialProgress: previousProgress } }
  const requests = []
  const intervalHandle = {}
  let intervalCallback
  let intervalMs
  let clearCalls = 0
  let pump
  const observed = {}
  t.mock.method(globalThis, 'setInterval', (callback, ms) => {
    intervalCallback = callback
    intervalMs = ms
    return intervalHandle
  })
  t.mock.method(globalThis, 'clearInterval', (handle) => {
    assert.equal(handle, intervalHandle)
    clearCalls += 1
  })
  const request = (socket, deadlineMs, method, params) => {
    let resolve
    let reject
    const completion = new Promise((resolveRequest, rejectRequest) => {
      resolve = resolveRequest
      reject = rejectRequest
    })
    requests.push({ socket, deadlineMs, method, params, completion, resolve, reject })
    return completion
  }
  try {
    pump = startCaptionAudioPump({ ws, request, captionFake, streamSessionId })
    observed.immediateRequestCount = requests.length
    observed.progressDuring = captionFake.state.realtimePartialProgress
    intervalCallback()
    observed.scheduledRequestCount = requests.length
    observed.intervalMs = intervalMs
  } finally {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => {
        pump?.stop()
        pump?.stop()
        intervalCallback?.()
        observed.progressAfter = captionFake.state.realtimePartialProgress
        observed.clearCalls = clearCalls
        observed.requestCountAfterStop = requests.length
      }),
      Promise.resolve().then(async () => {
        for (const owned of requests) {
          if (refuse) owned.reject(new Error('Controlled owned RPC refusal.'))
          else owned.resolve({ framesAccepted: 10, packetsGenerated: 10 })
        }
        await bounded(
          Promise.allSettled(requests.map((owned) => owned.completion)),
          'Owned requests'
        )
      })
    ])
    t.mock.restoreAll()
    const failed = cleanup.filter((entry) => entry.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map((entry) => entry.reason),
        'Pump cleanup'
      )
  }
  observed.requests = requests.map(({ socket, deadlineMs, method, params }) => ({
    sameSocket: socket === ws,
    deadlineMs,
    method,
    params
  }))
  return observed
}

it('keeps idle consent audio on the installed caption tap with its original request deadline', async (t) => {
  const observed = await observePump(t)
  assert.deepEqual(observed.requests, [
    {
      sameSocket: true,
      deadlineMs: 5_000,
      method: 'captions.test.inject-audio',
      params: { durationMs: 200 }
    },
    {
      sameSocket: true,
      deadlineMs: 5_000,
      method: 'captions.test.inject-audio',
      params: { durationMs: 200 }
    }
  ])
})

it('routes the confirmed stream owner through its native PCM controller rather than a second tap clock', async (t) => {
  const observed = await observePump(t, { streamSessionId: 'confirmed-local-stream' })
  assert.deepEqual(observed.requests, [
    {
      sameSocket: true,
      deadlineMs: 5_000,
      method: 'audio.test.inject-pcm',
      params: { sessionId: 'confirmed-local-stream', durationMs: 200, rawPeak: 0.12 }
    },
    {
      sameSocket: true,
      deadlineMs: 5_000,
      method: 'audio.test.inject-pcm',
      params: { sessionId: 'confirmed-local-stream', durationMs: 200, rawPeak: 0.12 }
    }
  ])
})

it('pumps immediately, schedules the unchanged one-second cadence, and stops idempotently', async (t) => {
  const observed = await observePump(t)
  assert.equal(observed.immediateRequestCount, 1)
  assert.equal(observed.scheduledRequestCount, 2)
  assert.equal(observed.intervalMs, 1_000)
  assert.equal(observed.progressDuring, true)
  assert.equal(observed.progressAfter, false)
  assert.equal(observed.clearCalls, 1)
  assert.equal(observed.requestCountAfterStop, 2)
})

it('restores a previously enabled Partial owner on stop', async (t) => {
  const observed = await observePump(t, { previousProgress: true })
  assert.equal(observed.progressDuring, true)
  assert.equal(observed.progressAfter, true)
  assert.equal(observed.clearCalls, 1)
})

it('restores progress and retires the timer even when an owned request is refused', async (t) => {
  const observed = await observePump(t, { refuse: true })
  assert.equal(observed.progressAfter, false)
  assert.equal(observed.clearCalls, 1)
  assert.equal(observed.requestCountAfterStop, 2)
})

it('selects the existing permissionless native microphone and keeps scripted stream speech audible', () => {
  const params = streamSessionParams('owned-output-capability', 19781)
  assert.deepEqual(params.sources, {
    testPattern: true,
    microphoneId: 'microphone:coreaudio:4294967295'
  })
  assert.deepEqual(params.audio, {
    microphoneGainDb: 0,
    microphoneMuted: false,
    microphoneSyncOffsetMs: 0
  })
})

it('preserves the original stream output, layout, target and capability contract', () => {
  const params = streamSessionParams('owned-output-capability', 19781)
  const target = {
    id: 'cohost-smoke-rtmp',
    platform: 'custom',
    label: 'Local co-host smoke',
    enabled: true,
    serverUrl: 'rtmp://127.0.0.1:19781/live',
    urlMode: 'server-and-key',
    streamKey: 'cohost-smoke',
    streamKeyPresent: true,
    authMode: 'manual-rtmp',
    outputPreset: 'stream-safe-1080p30',
    outputBitrateKbps: 6000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  assert.deepEqual(Object.keys(params).sort(), [
    'audio',
    'layout',
    'output',
    'sources',
    'streaming'
  ])
  assert.deepEqual(params.output, {
    recordEnabled: false,
    streamEnabled: true,
    outputDirectoryCapability: 'owned-output-capability',
    video: { preset: 'custom', width: 640, height: 360, fps: 30, bitrateKbps: 2000 },
    rtmp: { preset: 'custom', serverUrl: target.serverUrl, streamKey: target.streamKey }
  })
  assert.deepEqual(params.streaming, {
    enabled: true,
    mode: 'single',
    targets: [target],
    selectedTargetId: target.id,
    defaultOutputPreset: target.outputPreset,
    defaultBitrateKbps: target.outputBitrateKbps,
    enabledTargetIds: [target.id]
  })
  assert.deepEqual(params.layout, {
    layoutPreset: 'screen-only',
    cameraTransformMode: 'preset',
    cameraTransform: null,
    cameraCorner: 'bottom-right',
    cameraSize: 'medium',
    cameraShape: 'rectangle',
    cameraCornerRadiusPct: 12,
    cameraAspect: 'source',
    cameraMargin: 32,
    cameraFit: 'fill',
    cameraMirror: false,
    cameraZoom: 100,
    cameraOffsetX: 0,
    cameraOffsetY: 0,
    sideBySideSplit: '70-30',
    sideBySideCameraSide: 'right'
  })
})
