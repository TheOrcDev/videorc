import { describe, expect, it } from 'vitest'
import {
  ROOM_SCREEN_CAPTURE_FACTS,
  capturerIdForNative,
  nativeIdForCapturer,
  roomScreenNeedsSwitch,
  roomScreenWant
} from './room-screen-source'

describe('S14 room screen source', () => {
  it('maps ScreenCaptureKit ids to the capturer ids of the same display or window', () => {
    expect(capturerIdForNative('screen:screencapturekit:5')).toBe('screen:5:0')
    expect(capturerIdForNative('window:screencapturekit:4294967293')).toBe('window:4294967293:0')
    expect(capturerIdForNative('screen:avfoundation:1')).toBeNull()
    expect(capturerIdForNative('window:screencapturekit:0')).toBeNull()
    expect(capturerIdForNative('window:screencapturekit:99999999999')).toBeNull()
    expect(capturerIdForNative(undefined)).toBeNull()
  })
  it('maps capturer ids back to ScreenCaptureKit ids for the backend room (plan 260 S1.8c)', () => {
    expect(nativeIdForCapturer('screen:5:0')).toBe('screen:screencapturekit:5')
    expect(nativeIdForCapturer('window:4294967293:0')).toBe('window:screencapturekit:4294967293')
    expect(nativeIdForCapturer('screen:5:1')).toBeNull()
    expect(nativeIdForCapturer('window:0:0')).toBeNull()
    expect(nativeIdForCapturer('web-contents-media-stream:1')).toBeNull()
    expect(nativeIdForCapturer(undefined)).toBeNull()
    for (const native of ['screen:screencapturekit:7', 'window:screencapturekit:42'])
      expect(nativeIdForCapturer(capturerIdForNative(native) ?? undefined)).toBe(native)
  })
  it('a window wins over a display; None and no source keep the share', () => {
    expect(
      roomScreenWant({
        screenId: 'screen:screencapturekit:1',
        windowId: 'window:screencapturekit:42'
      })
    ).toEqual({
      kind: 'source',
      capturerId: 'window:42:0',
      sourceKind: 'window',
      nativeId: 'window:screencapturekit:42'
    })
    expect(roomScreenWant({ screenId: 'screen:screencapturekit:1' })).toEqual({
      kind: 'source',
      capturerId: 'screen:1:0',
      sourceKind: 'screen',
      nativeId: 'screen:screencapturekit:1'
    })
    expect(roomScreenWant({ screenId: 'screen:screencapturekit:1', captureOff: true })).toEqual({
      kind: 'keep'
    })
    expect(roomScreenWant({})).toEqual({ kind: 'keep' })
  })
  it('a source that does not map is said, never guessed', () => {
    const want = roomScreenWant({ screenId: 'screen:wgc:0' })
    expect(want.kind).toBe('unsupported')
  })
  it('switches only when the room shares something else', () => {
    const want = roomScreenWant({ windowId: 'window:screencapturekit:42' })
    expect(roomScreenNeedsSwitch(want, 'window:42:0')).toBe(false)
    expect(roomScreenNeedsSwitch(want, 'screen:1:0')).toBe(true)
    expect(roomScreenNeedsSwitch(want, null)).toBe(true)
    expect(roomScreenNeedsSwitch({ kind: 'keep' }, null)).toBe(false)
  })
  it('states its capture facts and claims no qualification', () => {
    expect(ROOM_SCREEN_CAPTURE_FACTS).toMatchObject({
      cursor: 'capturer-default',
      ownWindows: 'content-protection-only',
      productionQualified: false
    })
  })
})
