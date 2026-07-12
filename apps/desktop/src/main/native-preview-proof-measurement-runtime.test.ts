import { describe, expect, it } from 'vitest'

import { NATIVE_PREVIEW_PROOF_MEASUREMENT_RUNTIME_SCRIPT } from './native-preview-proof-measurement-runtime'

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
