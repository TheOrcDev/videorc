import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertBmpHeaders,
  assertNonblankBmp,
  nativeWindowsCompositorUsesScreen,
  nativeWindowsScreenCandidates,
  nativeWindowsScreenRecordingActive,
  selectNativeWindowsScreen
} from './windows-native-screen-gates.mjs'

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
