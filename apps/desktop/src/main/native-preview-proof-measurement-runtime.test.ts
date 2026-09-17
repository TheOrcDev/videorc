import { describe, expect, it } from 'vitest'

import {
  NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT,
  resetNativePreviewProofMeasurementStatus
} from './native-preview-proof-measurement-runtime'

type MeasurementEpoch = Record<string, unknown>

type MeasurementRuntime = {
  createEpoch: (now: number, blankFrames: number, skippedFrames: number) => MeasurementEpoch
  recordFrame: (epoch: MeasurementEpoch, now: number) => void
  recordLatency: (epoch: MeasurementEpoch, latencyMs: number) => void
  snapshot: (
    epoch: MeasurementEpoch,
    now: number,
    blankFrames: number,
    skippedFrames: number
  ) => Record<string, number | null>
}

function loadRuntime(): MeasurementRuntime {
  const createRuntime = new Function(
    `${NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT}\nreturn {
      createEpoch: createNativePreviewProofMeasurementEpoch,
      recordFrame: recordNativePreviewProofMeasurementFrame,
      recordLatency: recordNativePreviewProofMeasurementLatency,
      snapshot: nativePreviewProofMeasurementSnapshot
    };`
  )
  return createRuntime() as MeasurementRuntime
}

describe('Windows proof-surface measurement runtime', () => {
  it('clears stale main-process metrics when the proof measurement epoch resets', () => {
    const status = resetNativePreviewProofMeasurementStatus({
      state: 'live',
      source: 'camera',
      transport: 'electron-proof-surface',
      backing: 'electron-browser-window',
      targetFps: 60,
      width: 1280,
      height: 720,
      framesRendered: 120,
      droppedFrames: 3,
      inputToPresentLatencyMs: 400,
      inputToPresentLatencyP50Ms: 410,
      inputToPresentLatencyP95Ms: 450,
      inputToPresentLatencyP99Ms: 462,
      presentFps: 12,
      intervalP95Ms: 300,
      intervalP99Ms: 350,
      framePollingSuppressed: false,
      sourcePixelsPresent: true,
      pendingHostCommandCount: 0,
      updatedAt: '2026-07-19T16:00:00.000Z'
    })

    expect(status).toMatchObject({
      state: 'live',
      framesRendered: 120,
      droppedFrames: 0,
      sourcePixelsPresent: true
    })
    expect(status.inputToPresentLatencyMs).toBeUndefined()
    expect(status.inputToPresentLatencyP50Ms).toBeUndefined()
    expect(status.inputToPresentLatencyP95Ms).toBeUndefined()
    expect(status.inputToPresentLatencyP99Ms).toBeUndefined()
    expect(status.presentFps).toBeUndefined()
    expect(status.intervalP95Ms).toBeUndefined()
    expect(status.intervalP99Ms).toBeUndefined()
  })

  it('reports only samples and counter deltas from the current epoch', () => {
    const runtime = loadRuntime()
    const startup = runtime.createEpoch(0, 2, 3)
    runtime.recordFrame(startup, 10)
    runtime.recordFrame(startup, 20)
    runtime.recordLatency(startup, 400)

    const measurement = runtime.createEpoch(100, 5, 7)
    runtime.recordFrame(measurement, 110)
    runtime.recordFrame(measurement, 130)
    runtime.recordFrame(measurement, 150)
    runtime.recordLatency(measurement, 24)
    runtime.recordLatency(measurement, 32)

    expect(runtime.snapshot(measurement, 160, 6, 9)).toMatchObject({
      measuredFps: 50,
      intervalP95Ms: 20,
      inputToPresentLatencyP50Ms: 24,
      inputToPresentLatencyP95Ms: 32,
      inputToPresentLatencyP99Ms: 32,
      blankFrames: 1,
      skippedCompositorFrames: 2
    })
  })
})
