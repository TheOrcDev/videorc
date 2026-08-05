import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertBmpHeaders,
  assertNonblankBmp,
  assertWindowsGraphicsCaptureTexture,
  evaluateWindowsNativeScreenD3d11Diagnostics,
  nativeWindowsCompositorUsesScreen,
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive,
  parseWindowsNativeScreenArgs,
  requiredBmpPreviewAdvances,
  selectNativeWindowsScreen,
  windowsNativeScreenPerformanceBudgetContext,
  windowsNativeScreenRequiresFinalDiagnostics
} from './windows-native-screen-gates.mjs'

test('Windows Graphics Capture gate requires a live retained D3D11 texture', () => {
  const live = {
    state: 'live',
    framesCaptured: 2,
    actualWidth: 1920,
    actualHeight: 1080,
    d3d11TextureAvailable: true
  }

  assert.doesNotThrow(() => assertWindowsGraphicsCaptureTexture(live))
  assert.throws(
    () => assertWindowsGraphicsCaptureTexture({ ...live, d3d11TextureAvailable: false }),
    /did not retain/
  )
  assert.throws(
    () => assertWindowsGraphicsCaptureTexture({ ...live, framesCaptured: 0 }),
    /evidence is incomplete/
  )
})

test('native Windows screen arguments select D3D11 or natural fallback strictly', () => {
  assert.deepEqual(
    parseWindowsNativeScreenArgs(['--', '--d3d11', '--require-d3d11']),
    parseWindowsNativeScreenArgs(['--d3d11', '--require-d3d11'])
  )
  assert.deepEqual(parseWindowsNativeScreenArgs(['--d3d11', '--require-d3d11']), {
    d3d11: true,
    requireD3d11: true,
    expectFallback: null
  })
  assert.deepEqual(parseWindowsNativeScreenArgs(['--expect-fallback', 'natural']), {
    d3d11: false,
    requireD3d11: false,
    expectFallback: 'natural'
  })
  assert.throws(() => parseWindowsNativeScreenArgs(['--require-d3d11']), /requires --d3d11/)
  assert.throws(
    () =>
      parseWindowsNativeScreenArgs(['--d3d11', '--require-d3d11', '--expect-fallback', 'natural']),
    /cannot be combined/
  )
})

test('native Windows D3D11 diagnostics prove zero-copy output and named fallback', () => {
  const live = {
    windowsD3d11Media: {
      state: 'live',
      captureBackend: 'desktop-duplication',
      captureReadbackFrames: 0,
      compositorCpuFallbackFrames: 0,
      encoderSystemMemorySamples: 0,
      rawVideoCopiedFrames: 0,
      previewBmpRequests: 0,
      previewBmpBytes: 0,
      adapterMismatches: 0,
      textureImportFrames: 120,
      encoderGpuSamples: 118,
      fallbackReason: null
    }
  }
  assert.deepEqual(evaluateWindowsNativeScreenD3d11Diagnostics(live, { requireOutput: true }), [])

  const copied = structuredClone(live)
  copied.windowsD3d11Media.captureReadbackFrames = 1
  copied.windowsD3d11Media.previewBmpRequests = 2
  assert.deepEqual(evaluateWindowsNativeScreenD3d11Diagnostics(copied, { requireOutput: true }), [
    'captureReadbackFrames=1',
    'BMP=2 requests/0 bytes'
  ])

  assert.deepEqual(
    evaluateWindowsNativeScreenD3d11Diagnostics(
      {
        windowsD3d11Media: {
          state: 'fallback',
          captureBackend: 'legacy-ffmpeg',
          fallbackReason: 'required-fence-interface-unavailable'
        }
      },
      { expectFallback: 'natural' }
    ),
    []
  )
})

test('native Windows screen requests final diagnostics only for diagnostics-gated lanes', () => {
  assert.equal(windowsNativeScreenRequiresFinalDiagnostics(), false)
  assert.equal(
    windowsNativeScreenRequiresFinalDiagnostics({
      requireEncodedBridge: false,
      d3d11: false,
      expectFallback: null
    }),
    false
  )
  assert.equal(windowsNativeScreenRequiresFinalDiagnostics({ requireEncodedBridge: true }), true)
  assert.equal(windowsNativeScreenRequiresFinalDiagnostics({ d3d11: true }), true)
  assert.equal(windowsNativeScreenRequiresFinalDiagnostics({ expectFallback: 'natural' }), true)
})

test('native Windows screen selection prefers DXGI and falls back to gdigrab', () => {
  const gdigrab = {
    id: 'screen:gdigrab:desktop',
    kind: 'screen',
    status: 'available'
  }
  const dxgi = {
    id: 'screen:dxgi:00000000000003f1:2',
    kind: 'screen',
    status: 'available'
  }
  assert.equal(selectNativeWindowsScreen([gdigrab, dxgi]), dxgi)
  assert.equal(selectNativeWindowsScreen([gdigrab]), gdigrab)
  assert.equal(selectNativeWindowsScreen([{ ...dxgi, status: 'unavailable' }]), null)
  assert.deepEqual(
    nativeWindowsScreenCandidates([dxgi]).map((device) => device.id),
    [dxgi.id, 'screen:gdigrab:desktop']
  )
  assert.deepEqual(nativeWindowsScreenCandidates([gdigrab]), [gdigrab])
})

test('BMP preview liveness threshold is relaxed only for the hosted software renderer', () => {
  assert.equal(requiredBmpPreviewAdvances({ detail: 'Microsoft Basic Render Driver' }), 3)
  assert.equal(requiredBmpPreviewAdvances({ detail: 'NVIDIA GeForce GTX 1650 SUPER' }), 5)
  assert.equal(requiredBmpPreviewAdvances({}), 5)
})

test('native Windows budget context binds the actual packaged payload digest', () => {
  const timing = { warmupMs: 60_000, measurementMs: 600_000, intervalMs: 1_000 }
  assert.deepEqual(
    windowsNativeScreenPerformanceBudgetContext({
      metadata: {
        hardwareClass: 'win11-lab-a',
        profileClass: 'endurance',
        buildMode: 'packaged',
        operatingSystem: {
          platform: 'win32',
          arch: 'x64',
          release: '10.0.26100'
        },
        packagePayload: { sha256: 'a'.repeat(64) }
      },
      scenario: 'windows-proof-recording-1080p60',
      timing
    }),
    {
      scenario: 'windows-proof-recording-1080p60',
      hardwareClass: 'win11-lab-a',
      profileClass: 'endurance',
      buildMode: 'packaged',
      operatingSystem: {
        platform: 'win32',
        arch: 'x64',
        release: '10.0.26100'
      },
      timing,
      candidatePayloadSha256: 'a'.repeat(64)
    }
  )
})

test('native ScreenOnly recording proof joins recording, compositor, and source authority', () => {
  const sourceId = 'screen:gdigrab:desktop'
  const evidence = {
    diagnostics: {
      activeOutputMode: 'record',
      sourceRegistry: {
        entries: [{ key: { kind: 'screen', id: sourceId }, status: 'live', consumers: ['preview'] }]
      }
    },
    compositor: {
      state: 'live',
      sceneRevision: 42,
      frameSceneRevision: 42,
      sceneLayout: { layoutPreset: 'screen-only' },
      sceneSources: [
        {
          kind: 'screen',
          deviceId: sourceId,
          visible: true,
          state: 'referenced'
        }
      ],
      sources: [{ kind: 'screen', sourceId, state: 'live', sequence: 17 }]
    },
    recording: { state: 'recording' }
  }

  assert.equal(nativeWindowsScreenRecordingActive(evidence, sourceId), true)
  assert.equal(nativeWindowsCompositorUsesScreen(evidence.compositor, sourceId), true)
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        diagnostics: {
          ...evidence.diagnostics,
          windowsD3d11Media: {
            state: 'live',
            encoderGpuSamples: 1,
            encoderSystemMemorySamples: 0,
            rawVideoCopiedFrames: 0
          }
        },
        compositor: { state: 'idle' }
      },
      sourceId
    ),
    true
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        compositor: {
          ...evidence.compositor,
          sceneSources: [
            {
              kind: 'screen',
              deviceId: 'screen:other',
              visible: true,
              state: 'referenced'
            }
          ]
        }
      },
      sourceId
    ),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        diagnostics: {
          ...evidence.diagnostics,
          sourceRegistry: { entries: [] }
        }
      },
      sourceId
    ),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        compositor: {
          ...evidence.compositor,
          sceneSources: evidence.compositor.sceneSources.map((source) => ({
            ...source,
            visible: false
          }))
        }
      },
      sourceId
    ),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive({ ...evidence, recording: { state: 'idle' } }, sourceId),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        compositor: { ...evidence.compositor, sources: [] }
      },
      sourceId
    ),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        compositor: { ...evidence.compositor, frameSceneRevision: 41 }
      },
      sourceId
    ),
    false
  )
  assert.equal(
    nativeWindowsScreenRecordingActive(
      {
        ...evidence,
        compositor: {
          ...evidence.compositor,
          activeScreenId: 'takeover-1',
          sceneSources: [
            ...evidence.compositor.sceneSources,
            { kind: 'screen-image', visible: true, state: 'live' }
          ]
        }
      },
      sourceId
    ),
    false
  )
})

test('BMP gate accepts generation-aware BGRA headers and visible decoded pixels', () => {
  const headers = bmpHeaders(2, 2)
  const bytes = bmp(2, 2, [
    [0, 0, 0, 255],
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255]
  ])

  assert.doesNotThrow(() => assertBmpHeaders(headers, 200))
  assert.doesNotThrow(() => assertNonblankBmp(bytes, headers))
  assert.doesNotThrow(() =>
    assertNonblankBmp(
      bmp(2, 2, [
        [0, 0, 0, 0],
        [255, 0, 0, 0],
        [0, 255, 0, 0],
        [0, 0, 255, 0]
      ]),
      headers
    )
  )
  assert.doesNotThrow(() =>
    assertBmpHeaders(
      {
        'x-videorc-frame-transport': 'latest-bgra-bmp',
        'x-videorc-frame-generation': 'run-a',
        'x-videorc-frame-sequence': '9'
      },
      204
    )
  )
})

test('BMP gate rejects missing metadata, transparent frames, and constant frames', () => {
  const headers = bmpHeaders(2, 2)
  assert.throws(
    () => assertBmpHeaders({ ...headers, 'x-videorc-frame-generation': '' }, 200),
    /cursor\/transport/
  )
  assert.throws(
    () => assertNonblankBmp(bmp(2, 2, Array(4).fill([0, 0, 0, 0])), headers),
    /blank\/constant/
  )
  assert.throws(
    () => assertNonblankBmp(bmp(2, 2, Array(4).fill([20, 20, 20, 255])), headers),
    /blank\/constant/
  )
})

function bmpHeaders(width, height) {
  return {
    'content-type': 'image/bmp',
    'x-videorc-frame-transport': 'latest-bgra-bmp',
    'x-videorc-frame-generation': 'run-a',
    'x-videorc-frame-sequence': '9',
    'x-videorc-frame-width': String(width),
    'x-videorc-frame-height': String(height),
    'x-videorc-frame-stride': String(width * 4),
    'x-videorc-pixel-format': 'bgra8'
  }
}

function bmp(width, height, pixels) {
  const pixelBytes = width * height * 4
  const bytes = Buffer.alloc(54 + pixelBytes)
  bytes.write('BM', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(-height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(32, 28)
  for (let index = 0; index < pixels.length; index += 1) {
    const [b, g, r, a] = pixels[index]
    const offset = 54 + index * 4
    bytes[offset] = b
    bytes[offset + 1] = g
    bytes[offset + 2] = r
    bytes[offset + 3] = a
  }
  return bytes
}
