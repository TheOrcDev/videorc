import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertBmpHeaders,
  assertNonblankBmp,
  nativeWindowsScreenCandidates,
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
