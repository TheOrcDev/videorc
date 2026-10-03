import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PREVIEW_INTERACTION_STRESS_PROFILE,
  analyzeCgWindowObservations,
  analyzeNativeStatusSamples,
  cgOraclePreviewReady,
  effectivePresentFpsFloor,
  pixelOracleCaptureSize,
  layoutIntentDiagnostic,
  previewInteractionPhaseEvidence,
  previewMeasurementEvidence,
  previewSceneTransitionEvidence,
  previewCgWindowEvidence,
  PREVIEW_TIMELINE_LIMITS
} from './preview-interaction-stress.mjs'

describe('preview interaction stress contract', () => {
  it('writes only bounded CGWindow geometry/order and authenticated fixed roles', () => {
    const sample = {
      receivedAt: 1_000,
      uptimeNs: 100_000,
      windows: [
        {
          order: 0,
          pid: 42,
          id: 123,
          name: 'Videorc Preview',
          owner: 'Electron',
          layer: 0,
          alpha: 1,
          x: -10,
          y: 20,
          width: 960,
          height: 540,
          nativeWindowHandle: 'private handle'
        },
        {
          order: 1,
          pid: 43,
          name: 'Videorc Preview',
          owner: 'private owner',
          layer: 0,
          alpha: 1,
          x: 0,
          y: 0,
          width: 10,
          height: 10
        },
        {
          order: 2,
          pid: 42,
          name: 'private title',
          owner: 'private owner',
          layer: 1,
          alpha: 1,
          x: 0,
          y: 0,
          width: 10,
          height: 10
        }
      ],
      pixel: {
        sampleCount: 100,
        meanLuma: 10,
        nonDarkFraction: 0.5,
        blankBaseFraction: 0,
        extra: 'private pixel payload'
      },
      pixelError: 'private provider error'
    }
    const reduced = previewCgWindowEvidence(sample, 42)
    assert.equal(reduced.windows[0].role, 'preview')
    assert.equal(reduced.windows[0].ownerCategory, 'owned-app')
    assert.equal(reduced.windows[0].x, -10)
    assert.equal(reduced.windows[1].role, 'unknown')
    assert.equal(reduced.windows[1].ownerCategory, 'other-or-unknown')
    assert.equal(reduced.windows[2].role, 'owned-other')
    assert.equal(reduced.pixelErrorPresent, true)
    assert.equal(previewCgWindowEvidence(sample, undefined).windows[0].role, 'unknown')
    assert.doesNotMatch(
      JSON.stringify(reduced),
      /private|nativeWindowHandle|Electron|Videorc|"pid"|"id"/
    )
    assert.equal(
      previewCgWindowEvidence({ windows: Array.from({ length: 258 }, () => sample.windows[0]) }, 42)
        .omittedWindows,
      2
    )
  })

  it('attributes the 114ms freshness sample to its presented frame without replacing it with input timing', () => {
    const presentation = {
      frameId: 36,
      runId: 'run-a',
      sceneRevision: 9,
      frameAgeMs: 97,
      compositorUpdatedAt: new Date(983).toISOString(),
      presentedAtMs: 1_000,
      presentStartedMonotonicMs: 50,
      presentCompletedMonotonicMs: 52,
      inputToPresentLatencyMs: 114,
      nativeWindowHandle: 'private handle'
    }
    const evidence = previewInteractionPhaseEvidence({
      startedAt: 900,
      finishedAt: 1_100,
      measurement: { measurementStartedAtMs: 950 },
      samples: [
        {
          at: 1_010,
          status: {
            state: 'live',
            presentedFrameId: 36,
            nativePreviewCompositorRunId: 'run-a',
            nativePreviewPresentedSceneRevision: 9,
            updatedAt: new Date(1_009).toISOString(),
            inputToPresentLatencyMs: 114,
            nativePreviewPresentationEvidence: presentation,
            title: 'private title',
            token: 'private token'
          }
        }
      ],
      clickFocus: {
        steps: [
          {
            label: 'preview-window-click',
            action: { appliedAtMs: 48, completedAtMs: 49, wallClockAppliedAtMs: 998 },
            verificationCompletedAtMs: 1_080,
            verificationCompletedMonotonicMs: 130,
            presentationEvidence: presentation
          }
        ]
      }
    })
    assert.equal(evidence.samples[0].presentation.inputToPresentLatencyMs, 114)
    assert.equal(evidence.samples[0].presentation.frameAgeMs, 97)
    assert.equal(evidence.samples[0].presentation.presentedAtMs, 1_000)
    assert.equal(evidence.samples[0].presentationMatchesStatus, true)
    assert.equal(evidence.samples[0].presentedBeforeMeasurement, false)
    assert.equal(evidence.actions[0].action.wallClockAppliedAtMs, 998)
    assert.equal(evidence.actions[0].verificationCompletedAtMs, 1_080)
    assert.doesNotMatch(JSON.stringify(evidence), /private/)
    assert.equal(PREVIEW_INTERACTION_STRESS_PROFILE.thresholds.maxInputToPresentP95Ms, 100)
  })

  it('retains and labels samples and successful presents from before the metric reset', () => {
    const presentation = {
      frameId: 4,
      runId: 'run-a',
      sceneRevision: 1,
      presentedAtMs: 900,
      presentStartedMonotonicMs: 30,
      presentCompletedMonotonicMs: 32
    }
    const evidence = previewInteractionPhaseEvidence({
      measurement: { measurementStartedAtMs: 1_000 },
      samples: [990, 1_010].map((at) => ({
        at,
        status: {
          presentedFrameId: 4,
          nativePreviewCompositorRunId: 'run-a',
          nativePreviewPresentedSceneRevision: 1,
          updatedAt: new Date(at).toISOString(),
          nativePreviewPresentationEvidence: presentation
        }
      }))
    })
    assert.equal(evidence.samples.length, 2)
    assert.deepEqual(
      evidence.samples.map((row) => row.sampledBeforeMeasurement),
      [true, false]
    )
    assert.deepEqual(
      evidence.samples.map((row) => row.presentedBeforeMeasurement),
      [true, true]
    )
    assert.equal(evidence.samples[1].presentation.presentedAtMs, 900)
    assert.equal(evidence.samples[1].statusUpdatedAtMs, 1_010)
  })

  it('reports unknown, mismatched and clock-shifted ownership without making it fresh', () => {
    const evidence = previewInteractionPhaseEvidence({
      measurement: { measurementStartedAtMs: 1_000 },
      samples: [
        { at: 1_001, status: {} },
        {
          at: 1_002,
          status: {
            presentedFrameId: 2,
            nativePreviewCompositorRunId: 'run-b',
            nativePreviewPresentedSceneRevision: 2,
            nativePreviewPresentationEvidence: {
              frameId: 1,
              runId: 'run-a',
              sceneRevision: 1,
              presentedAtMs: 1_100,
              presentStartedMonotonicMs: 40,
              presentCompletedMonotonicMs: 42
            }
          }
        }
      ]
    })
    assert.equal(evidence.samples[0].presentation, null)
    assert.equal(evidence.samples[0].presentedBeforeMeasurement, null)
    assert.equal(evidence.samples[1].presentationMatchesStatus, false)
    assert.equal(evidence.samples[1].presentedAfterSample, true)
    assert.equal(previewInteractionPhaseEvidence({ samples: [] }).measurementStartedAtMs, null)
  })

  it('retains bounds application lag and separate clock anchors without bounds payloads', () => {
    const evidence = previewInteractionPhaseEvidence({
      boundsResults: [
        {
          applied: 3,
          elapsedMs: 30,
          maxStartLagMs: 12,
          timing: {
            monotonicStartedAtMs: 1_000,
            wallClockStartedAtMs: 10_000,
            omitted: 0,
            entries: [
              {
                index: 0,
                scheduledAtMs: 1_000,
                appliedAtMs: 1_000,
                completedAtMs: 1_010,
                title: 'private'
              },
              { index: 1, scheduledAtMs: 1_004, appliedAtMs: 1_010, completedAtMs: 1_020 },
              { index: 2, scheduledAtMs: 1_008, appliedAtMs: 1_020, completedAtMs: 1_030 }
            ]
          }
        }
      ]
    })
    assert.equal(evidence.bounds[0].maxStartLagMs, 12)
    assert.equal(evidence.bounds[0].entries[2].appliedAtMs, 1_020)
    assert.equal(evidence.bounds[0].wallClockStartedAtMs, 10_000)
    assert.doesNotMatch(JSON.stringify(evidence), /private/)
    assert.deepEqual(previewInteractionPhaseEvidence({ boundsResults: [{}] }).bounds, [
      { available: false }
    ])
  })

  it('bounds retained evidence and explicitly reports omissions', () => {
    const evidence = previewInteractionPhaseEvidence({
      samples: Array.from({ length: PREVIEW_TIMELINE_LIMITS.samples + 3 }, (_, at) => ({
        at,
        status: {}
      })),
      clickFocus: { steps: Array.from({ length: 20 }, () => ({ label: 'baseline' })) }
    })
    assert.equal(evidence.samples.length, PREVIEW_TIMELINE_LIMITS.samples)
    assert.equal(evidence.omittedSamples, 3)
    assert.equal(evidence.samples[0].sampledAtMs, 3)
    assert.equal(evidence.actions.length, 16)
    assert.equal(evidence.omittedActions, 4)
  })

  it('refuses malformed scalar timing and strips unknown fields from aggregate measurement evidence', () => {
    const result = previewInteractionPhaseEvidence({
      samples: [
        {
          at: Infinity,
          status: {
            presentedFrameId: Number.MAX_SAFE_INTEGER + 1,
            nativePreviewCompositorRunId: 'x'.repeat(129),
            nativePreviewPresentationEvidence: {
              frameId: 2,
              presentedAtMs: NaN,
              presentStartedMonotonicMs: 30,
              presentCompletedMonotonicMs: 20
            }
          }
        }
      ]
    })
    assert.equal(result.samples[0].sampledAtMs, null)
    assert.equal(result.samples[0].presentedFrameId, null)
    assert.equal(result.samples[0].runId, null)
    assert.equal(result.samples[0].presentation, null)
    const measurement = previewMeasurementEvidence({
      inputToPresentLatencyP95Ms: 114,
      measuredFps: 59.97,
      status: { state: 'live', nativeWindowHandle: 'private' },
      secret: 'private'
    })
    assert.equal(measurement.inputToPresentLatencyP95Ms, 114)
    assert.equal(measurement.measuredFps, 59.97)
    assert.equal(measurement.identity.state, 'live')
    assert.doesNotMatch(JSON.stringify(measurement), /private|nativeWindowHandle|secret/)
    assert.equal(previewMeasurementEvidence(null), null)
  })

  it('keeps unavailable and every supported fallback identity attributable', () => {
    const identities = [
      ['unavailable', 'unavailable', 'none', 'external-module'],
      ['live', 'd3d11-shared-texture', 'directcomposition-swapchain', 'backend-d3d11-presenter'],
      ['live', 'electron-proof-surface', 'electron-browser-window', 'proof-surface'],
      ['live', 'latest-jpeg-polling', 'electron-browser-window', 'helper-process'],
      ['live', 'mjpeg-stream', 'electron-browser-window', 'in-process']
    ]
    for (const [state, transport, backing, hostKind] of identities) {
      const status = { state, transport, backing, nativePreviewHostKind: hostKind }
      const row = previewInteractionPhaseEvidence({ samples: [{ status }] }).samples[0]
      assert.deepEqual(
        [row.state, row.transport, row.backing, row.hostKind],
        [state, transport, backing, hostKind]
      )
      const measurement = previewMeasurementEvidence({ status })
      assert.deepEqual(
        [
          measurement.identity.state,
          measurement.identity.transport,
          measurement.identity.backing,
          measurement.identity.hostKind
        ],
        [state, transport, backing, hostKind]
      )
    }
  })

  it('requires valid frame, run and revision identities on both sides before proving ownership', () => {
    const presentation = {
      frameId: 4,
      runId: 'run-a',
      sceneRevision: 1,
      presentedAtMs: 900,
      presentStartedMonotonicMs: 30,
      presentCompletedMonotonicMs: 32
    }
    const status = {
      presentedFrameId: 4,
      nativePreviewCompositorRunId: 'run-a',
      nativePreviewPresentedSceneRevision: 1,
      nativePreviewPresentationEvidence: presentation
    }
    for (const field of [
      'presentedFrameId',
      'nativePreviewCompositorRunId',
      'nativePreviewPresentedSceneRevision'
    ]) {
      const incomplete = { ...status, [field]: undefined }
      assert.equal(
        previewInteractionPhaseEvidence({ samples: [{ status: incomplete }] }).samples[0]
          .presentationMatchesStatus,
        null
      )
    }
    for (const field of ['runId', 'sceneRevision']) {
      const incomplete = {
        ...status,
        nativePreviewPresentationEvidence: { ...presentation, [field]: undefined }
      }
      assert.equal(
        previewInteractionPhaseEvidence({ samples: [{ status: incomplete }] }).samples[0]
          .presentationMatchesStatus,
        null
      )
    }
    const groups = previewInteractionPhaseEvidence({ boundsResults: [{}, {}, {}] })
    assert.equal(groups.bounds.length, 2)
    assert.equal(groups.omittedBoundsGroups, 1)
  })

  it('keeps failed scene contracts and selected intent reviewable without raw scene/status data', () => {
    const row = layoutIntentDiagnostic(
      {
        visual: { sources: { cameraId: 'camera:1' }, layout: { layoutPreset: 'camera-only' } },
        recording: 'recording',
        diagnostics: {
          confirmedSceneRevision: 8,
          backendSceneRevision: 9
        }
      },
      'screen-only',
      'before',
      true,
      100
    )
    const transition = previewSceneTransitionEvidence(
      {
        preset: 'screen-only',
        selected: {
          preset: 'screen-only',
          pressed: false,
          disabled: true,
          timeline: [row],
          title: 'private'
        },
        surface: {
          layoutPreset: 'camera-only',
          sceneRevision: 8,
          visibleSourceIds: ['source:camera']
        },
        scene: {
          revision: 8,
          sources: [{ id: 'source:camera', kind: 'camera', visible: true, title: 'private' }]
        },
        compositor: { sceneRevision: 9, frameSceneRevision: 8, framesRendered: 36, runId: 'run-a' },
        nativeStatus: {
          presentedFrameId: 36,
          nativePreviewCompositorRunId: 'run-a',
          nativePreviewPresentedSceneRevision: 8,
          nativeWindowHandle: 'private'
        },
        failures: ['scene contract failed', 'revision mismatch']
      },
      ['screen']
    )
    assert.deepEqual(transition.failures, ['scene contract failed', 'revision mismatch'])
    assert.deepEqual(transition.expectedKinds.values, ['screen'])
    assert.deepEqual(transition.observedKinds.values, ['camera'])
    assert.equal(transition.selected.timeline.values[0].selected.cameraId, 'camera:1')
    assert.equal(transition.selected.timeline.values[0].backendSceneRevision, 9)
    assert.equal(transition.native.runId, 'run-a')
    assert.equal(transition.native.sceneRevision, 8)
    assert.deepEqual(transition.sourceVisibility.values, [
      { id: 'source:camera', kind: 'camera', visible: true }
    ])
    assert.doesNotMatch(JSON.stringify(transition), /private|nativeWindowHandle/)
    const bounded = previewSceneTransitionEvidence({
      scene: {
        sources: Array.from({ length: 130 }, (_, index) => ({
          id: `source:${index}`,
          kind: 'camera',
          visible: false
        }))
      },
      selected: { timeline: Array.from({ length: 65 }, () => row) }
    })
    assert.equal(bounded.sourceVisibility.omitted, 2)
    assert.equal(bounded.selected.timeline.omitted, 1)
  })

  it('captures only bounded per-click selected intent and availability diagnostics', () => {
    const state = {
      visual: {
        sources: {
          cameraId: 'camera:1',
          screenId: 'screen:1',
          cameraOff: false,
          cameraName: 'private title'
        },
        layout: { layoutPreset: 'screen-camera' }
      },
      pendingLayout: 'camera-only',
      recording: 'recording',
      credentials: 'private credential',
      diagnostics: {
        layoutIntentId: 42,
        layoutIntentAwaitingProof: 42,
        confirmedSceneRevision: 8,
        backendSceneRevision: 9,
        sourceSelectionState: { snapshot: { sourceRevision: 3, extra: 'private source data' } },
        selectedDeviceAvailability: { camera: 'available', screen: 'permission-required' },
        sceneGesturePending: true,
        sceneTransformPending: false
      }
    }
    const row = layoutIntentDiagnostic(state, 'screen-only', 'before', true, 100)
    assert.deepEqual(row, {
      at: 100,
      preset: 'screen-only',
      phase: 'before',
      disabled: true,
      selected: {
        cameraId: 'camera:1',
        screenId: 'screen:1',
        windowId: null,
        cameraOff: false,
        testPattern: false
      },
      availability: { camera: 'available', screen: 'permission-required', window: null },
      currentLayout: 'screen-camera',
      pendingLayout: 'camera-only',
      intentId: 42,
      awaitingProof: 42,
      confirmedSceneRevision: 8,
      backendSceneRevision: 9,
      sourceRevision: 3,
      sceneGesturePending: true,
      sceneTransformPending: false,
      recording: 'recording'
    })
    assert.doesNotMatch(JSON.stringify(row), /private/)
    // The maintained eval embeds exactly this projection, without dependencies.
    const embedded = new Function(`return (${layoutIntentDiagnostic.toString()})`)()
    assert.deepEqual(embedded(state, 'screen-only', 'before', true, 100), row)
    state.visual.sources.screenId = undefined
    assert.equal(
      layoutIntentDiagnostic(state, 'screen-only', 'after', true, 101).selected.screenId,
      null
    )
  })

  it('reports absent ownership and availability as unknown without inventing a ready source', () => {
    const row = layoutIntentDiagnostic(undefined, 'camera-only', 'before', undefined, 0)
    assert.equal(row.disabled, null)
    assert.equal(row.intentId, null)
    assert.equal(row.confirmedSceneRevision, null)
    assert.equal(row.backendSceneRevision, null)
    assert.deepEqual(row.availability, { camera: null, screen: null, window: null })
    assert.deepEqual(row.selected, {
      cameraId: null,
      screenId: null,
      windowId: null,
      cameraOff: false,
      testPattern: false
    })
  })

  it('allows measurement tolerance only when recording caps presentation at the floor', () => {
    assert.equal(effectivePresentFpsFloor(30, 60), 30)
    assert.equal(effectivePresentFpsFloor(30, 30), 28.5)
    assert.equal(effectivePresentFpsFloor(30, undefined), 30)
  })

  it('keeps the movement and rapid-scene workload from shrinking', () => {
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.floating, {
      positionUpdates: 120,
      cadenceMs: 16,
      burstUpdates: 60,
      burstCadenceMs: 4
    })
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.docked, {
      positionUpdates: 120,
      cadenceMs: 16,
      burstUpdates: 60,
      burstCadenceMs: 4
    })
    assert.equal(PREVIEW_INTERACTION_STRESS_PROFILE.sceneRounds, 10)
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.sceneSequence, [
      'camera-only',
      'screen-only',
      'side-by-side',
      'screen-camera'
    ])
  })

  it('caps the persistent pixel oracle without changing the preview aspect ratio', () => {
    assert.deepEqual(pixelOracleCaptureSize(1920, 1136), { width: 304, height: 180 })
    assert.deepEqual(pixelOracleCaptureSize(320, 180), { width: 320, height: 180 })
    assert.deepEqual(pixelOracleCaptureSize(4000, 1000), { width: 320, height: 80 })
    assert.deepEqual(PREVIEW_INTERACTION_STRESS_PROFILE.pixelOracle, {
      maxWidth: 320,
      maxHeight: 180,
      sampleIntervalMs: 200
    })
  })

  it('rejects native presentation stalls even when status still claims live', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40), sample(100, 40), sample(260, 40), sample(300, 41)],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.equal(result.maxFrameStallMs, 260)
    assert.match(result.failures.join('\n'), /presented-frame stall 260ms exceeded 250ms/)
  })

  it('scopes presented frame counters to their compositor run', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40, 'run-a'), sample(20, 41, 'run-a'), sample(40, 1, 'run-b')],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.equal(result.compositorRunTransitions, 1)
    assert.doesNotMatch(result.failures.join('\n'), /moved backwards/)
  })

  it('still rejects a presented frame regression inside one compositor run', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40, 'run-a'), sample(20, 41, 'run-a'), sample(40, 1, 'run-a')],
      { maxFrameStallMs: 250, maxSampleGapMs: 250, maxDroppedFrameDelta: 8 }
    )

    assert.match(result.failures.join('\n'), /presented frame moved backwards from 41 to 1/)
  })

  it('enforces the production profile frame-stall limit', () => {
    const result = analyzeNativeStatusSamples(
      [sample(0, 40), sample(100, 40), sample(260, 40), sample(300, 41)],
      PREVIEW_INTERACTION_STRESS_PROFILE.thresholds
    )

    assert.match(result.failures.join('\n'), /presented-frame stall 260ms exceeded 250ms/)
  })

  it('rejects silent transport downgrade and unbounded helper work', () => {
    const downgraded = sample(20, 42)
    downgraded.status.transport = 'electron-proof-surface'
    downgraded.status.backing = 'electron-browser-window'
    downgraded.status.pendingHostCommandCount = 2

    const result = analyzeNativeStatusSamples([sample(0, 41), downgraded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.match(result.failures.join('\n'), /transport electron-proof-surface/)
    assert.match(result.failures.join('\n'), /backing electron-browser-window/)
    assert.match(result.failures.join('\n'), /helper request depth 2 exceeded 1/)
  })

  it('allows one active in-process mutation plus one latest pending placement', () => {
    const bounded = sample(20, 42)
    bounded.status.nativePreviewHostKind = 'in-process'
    bounded.status.pendingHostCommandCount = 2

    const result = analyzeNativeStatusSamples([sample(0, 41), bounded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.doesNotMatch(result.failures.join('\n'), /request depth/)
  })

  it('rejects a third queued in-process host operation', () => {
    const unbounded = sample(20, 42)
    unbounded.status.nativePreviewHostKind = 'in-process'
    unbounded.status.pendingHostCommandCount = 3

    const result = analyzeNativeStatusSamples([sample(0, 41), unbounded], {
      maxFrameStallMs: 250,
      maxSampleGapMs: 250,
      maxDroppedFrameDelta: 8
    })

    assert.match(result.failures.join('\n'), /in-process request depth 3 exceeded 2/)
  })

  it('treats an in-process host as one OS-atomic Electron window with no helper', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
    assert.equal(result.maxSurfaceOffsetPx, 0)
    assert.equal(result.inProcessSamples, 1)
  })

  it('scopes the preview oracle to the launched Electron process', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow(), { ...electronWindow(), pid: 99, id: 100 }],
          processes: [
            { pid: 10, ppid: 1, command: 'Electron' },
            { pid: 99, ppid: 1, command: 'Electron' }
          ]
        }
      ],
      { expectedHostKind: 'in-process', expectedWindowPid: 10 }
    )

    assert.deepEqual(result.failures, [])
  })

  it('allows the one Electron preview window to change levels when always-on-top is toggled', () => {
    const raisedWindow = { ...electronWindow(), layer: 3 }
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [raisedWindow],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
  })

  it('identifies the in-process preview by window identity during a fast sampling race', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 800, y: 700, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.deepEqual(result.failures, [])
  })

  it('does not turn a stale oracle join into a vanished preview window', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        },
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          oracleObserved: false,
          windows: []
        },
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        }
      ],
      { expectedHostKind: 'in-process', minOracleCoverage: 0.5 }
    )

    assert.doesNotMatch(result.failures.join('\n'), /exactly one Electron preview window/)
    assert.doesNotMatch(result.failures.join('\n'), /could not identify the Electron preview base/)
    assert.equal(result.oracleUnavailableSamples, 1)
    assert.equal(result.inProcessNonNormalLayerSamples, 0)
  })

  it('fails separately when the persistent oracle has inadequate phase coverage', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()]
        },
        ...Array.from({ length: 3 }, () => ({
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          oracleObserved: false,
          windows: []
        }))
      ],
      { expectedHostKind: 'in-process', minOracleCoverage: 0.8 }
    )

    assert.match(result.failures.join('\n'), /oracle coverage 25\.0% was below 80\.0%/)
  })

  it('rejects a helper window or descendant process on the in-process path', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow(), helperWindow()],
          processes: [
            { pid: 10, ppid: 1, command: 'Electron' },
            { pid: 20, ppid: 10, command: 'native_preview_host_helper' }
          ]
        }
      ],
      { expectedHostKind: 'in-process' }
    )

    assert.match(result.failures.join('\n'), /in-process host exposed 1 helper CGWindow/)
    assert.match(result.failures.join('\n'), /spawned native_preview_host_helper/)
  })

  it('allows legitimately dark camera content in device mode', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 4,
            nonDarkFraction: 0.001,
            blankBaseFraction: 0.02
          }
        }
      ],
      { expectedHostKind: 'in-process', requirePixelOracle: true }
    )

    assert.doesNotMatch(result.failures.join('\n'), /preview base/)
  })

  it('rejects the exposed preview base in device mode', () => {
    const result = analyzeCgWindowObservations(
      [
        {
          expectedBounds: { x: 100, y: 130, width: 640, height: 360 },
          hostKind: 'in-process',
          windows: [electronWindow()],
          processes: [{ pid: 10, ppid: 1, command: 'Electron' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 13,
            nonDarkFraction: 0,
            blankBaseFraction: 0.99
          }
        }
      ],
      { expectedHostKind: 'in-process', requirePixelOracle: true }
    )

    assert.match(result.failures.join('\n'), /pixel oracle observed the preview base/)
  })

  it('does not start a phase until the exact preview window has visible pixels', () => {
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [{ ...electronWindow(), name: 'Videorc' }],
          pixel: {
            sampleCount: 1000,
            meanLuma: 30,
            nonDarkFraction: 0.4,
            blankBaseFraction: 0
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      false
    )
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [electronWindow()],
          pixel: {
            sampleCount: 1000,
            meanLuma: 13,
            nonDarkFraction: 0,
            blankBaseFraction: 0.99
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      false
    )
    assert.equal(
      cgOraclePreviewReady(
        {
          windows: [electronWindow()],
          pixel: {
            sampleCount: 1000,
            meanLuma: 3,
            nonDarkFraction: 0,
            blankBaseFraction: 0.01
          }
        },
        { hostKind: 'in-process', requirePixels: true }
      ),
      true
    )
  })
})

function sample(at, frame, runId) {
  return {
    at,
    status: {
      state: 'live',
      transport: 'native-surface',
      backing: 'cametal-layer',
      sourcePixelsPresent: true,
      framesRendered: frame,
      presentedFrameId: frame,
      droppedFrames: 0,
      pendingHostCommandCount: 0,
      ...(runId ? { nativePreviewCompositorRunId: runId } : {})
    }
  }
}

function electronWindow() {
  return {
    order: 2,
    id: 100,
    pid: 10,
    owner: 'Electron',
    name: 'Videorc Preview',
    layer: 0,
    alpha: 1,
    x: 100,
    y: 100,
    width: 640,
    height: 390
  }
}

function helperWindow() {
  return {
    order: 1,
    id: 200,
    pid: 20,
    owner: 'native_preview_host_helper',
    name: '',
    layer: 0,
    alpha: 1,
    x: 100,
    y: 130,
    width: 640,
    height: 360
  }
}
