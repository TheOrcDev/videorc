import { describe, expect, it } from 'vitest'
import { ALPHA_LIMITS, alphaDimensions, packedSize } from './cloud-alpha'
import {
  CAMERA_FRAME_CONTRACT,
  CAMERA_PACKED_ALPHA_ENABLED,
  ROOM_FRAME,
  bindCameraFramePublication,
  cameraFrameBinds,
  parseCameraFrameAuthority,
  publishSourceNames,
  cameraFrameLayout,
  cameraFrameTrackName,
  parseCameraFrameTrackName,
  cameraAlphaDimensions,
  cameraRoleDescriptor,
  decodeFrameStamp,
  frameStampBits,
  parseRoomFrameCommand,
  parseRoomFrameReply,
  roomFrameCapability,
  roomFrameCommand,
  type CameraFrameAuthority
} from './room-frame'

const authority: CameraFrameAuthority = {
  contract: CAMERA_FRAME_CONTRACT,
  show: 'sh_talk',
  hostIdentity: 'host:sh_talk',
  publisherSid: 'PA_host',
  trackSid: 'TR_camera',
  epoch: 'epoch1',
  generation: 42,
  source: 'camera',
  canPublishSources: ['camera', 'microphone']
}

describe('camera-frame publication contract', () => {
  it('binds one native generation to actual publication authority', () => {
    const bound = bindCameraFramePublication(authority, 42, 'opaque')
    expect(bound).toMatchObject({ contract: CAMERA_FRAME_CONTRACT, generation: 42 })
    expect(bound?.descriptor).toMatchObject({
      role: 'host-camera',
      alphaMode: 'opaque',
      geometryApplied: 'none'
    })
    for (const bad of [
      { ...authority, generation: 41 },
      { ...authority, hostIdentity: 'g_guest' },
      { ...authority, canPublishSources: ['microphone'] },
      { ...authority, trackSid: 'camera' },
      { ...authority, epoch: '' },
      { ...authority, contract: 'videorc:experimental:packed-alpha:v1' }
    ])
      expect(bindCameraFramePublication(bad as CameraFrameAuthority, 42, 'opaque')).toBeNull()
  })

  it('keeps packed camera mode disabled unless an explicit experiment asks', () => {
    expect(CAMERA_PACKED_ALPHA_ENABLED).toBe(false)
    expect(bindCameraFramePublication(authority, 42, 'packed')).toBeNull()
    const experiment = bindCameraFramePublication(authority, 42, 'packed', { experiment: true })
    expect(experiment?.descriptor).toMatchObject({
      packing: 'rgb-left-alpha-right',
      logicalWidth: 640,
      logicalHeight: 360,
      keyApplied: 'native-once'
    })
    expect(cameraAlphaDimensions(640, 360)).toBe(true)
    expect(cameraAlphaDimensions(360, 640)).toBe(true)
    expect(cameraAlphaDimensions(640, 640)).toBe(false)
    expect(cameraAlphaDimensions(63, 64)).toBe(false)
    expect(cameraRoleDescriptor('opaque').packing).toBeNull()
  })

  it('stamps sequences, not clocks, and refuses ambiguous cells', () => {
    const samples: number[] = frameStampBits(0xabcde).map((bit) => (bit ? 250 : 5))
    expect(decodeFrameStamp(samples)).toBe(0xabcde)
    samples[2] = 128
    expect(decodeFrameStamp(samples)).toBeNull()
  })

  it('validates commands and replies before use', () => {
    expect(parseRoomFrameCommand(roomFrameCommand('open', 1, 1))).toMatchObject({ action: 'open' })
    expect(() => parseRoomFrameCommand({ ...roomFrameCommand('open', 1, 1), serial: -1 })).toThrow()
    expect(() =>
      parseRoomFrameReply({ generation: 1, surfaceEpoch: 1, originUs: 5, incarnation: null })
    ).toThrow()
    expect(
      parseRoomFrameReply({ generation: 1, surfaceEpoch: 1, originUs: null, incarnation: null })
    ).toMatchObject({ originUs: null })
    expect(() =>
      parseRoomFrameReply({ generation: 1, surfaceEpoch: 1, revokedLeases: 3 })
    ).toThrow()
    expect(ROOM_FRAME.productionQualified).toBe(false)
  })

  it('keeps platform capabilities separate and unqualified', () => {
    expect(roomFrameCapability('darwin')).toMatchObject({
      transport: 'frame-copy',
      qualified: false
    })
    expect(roomFrameCapability('win32')).toMatchObject({
      transport: 'frame-copy',
      qualified: false
    })
    expect(roomFrameCapability('linux').transport).toBe('unsupported')
  })

  it('freezes the non-authoritative layout descriptor shared with S22 ISO', () => {
    expect(cameraFrameTrackName(cameraFrameLayout('packed'), 7)).toBe(
      'videorc:camera-frame:v1;frameLayout=rgb-left-alpha-right:g8;generation=7'
    )
    expect(cameraFrameTrackName(cameraFrameLayout('opaque'), 8)).toBe(
      'videorc:camera-frame:v1;frameLayout=opaque;generation=8'
    )
    expect(parseCameraFrameTrackName(cameraFrameTrackName('opaque', 8))).toEqual({
      layout: 'opaque',
      generation: 8
    })
    for (const bad of [
      'camera',
      'videorc:camera-frame:v1;frameLayout=rgba;generation=1',
      'videorc:camera-frame:v1;frameLayout=opaque;generation=0',
      'videorc:experimental:packed-alpha:v1:h:1',
      undefined
    ])
      expect(parseCameraFrameTrackName(bad)).toBeNull()
    expect(() => cameraFrameTrackName('opaque', 0)).toThrow()
  })

  it('mirrors the S10 packing and size rule exactly', () => {
    expect(ROOM_FRAME.gutter).toBe(ALPHA_LIMITS.gutter)
    expect(ROOM_FRAME.fps).toBe(ALPHA_LIMITS.fps)
    expect(packedSize(ROOM_FRAME.width, ROOM_FRAME.height)).toEqual({
      width: ROOM_FRAME.packedWidth,
      height: ROOM_FRAME.height
    })
    for (const [w, h] of [
      [640, 360],
      [360, 640],
      [64, 64],
      [640, 362],
      [63, 64],
      [642, 360],
      [640, 640]
    ])
      expect(cameraAlphaDimensions(w!, h!)).toBe(alphaDimensions(w!, h!))
  })

  it('parses controller authority strictly and binds only the exact publication', () => {
    expect(parseCameraFrameAuthority(authority)).toEqual(authority)
    for (const bad of [
      { ...authority, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { ...authority, role: 'host-camera' },
      { ...authority, canPublishSources: [1] },
      { ...authority, generation: 0 }
    ])
      expect(parseCameraFrameAuthority(bad)).toBeNull()
    const facts = {
      identity: 'host:sh_talk',
      participantSid: 'PA_host',
      trackSid: 'TR_camera',
      source: 'camera'
    }
    expect(cameraFrameBinds(authority, facts)).toBe(true)
    expect(cameraFrameBinds(authority, { ...facts, trackSid: 'TR_other' })).toBe(false)
    expect(cameraFrameBinds(authority, { ...facts, participantSid: 'PA_old' })).toBe(false)
    expect(cameraFrameBinds(authority, { ...facts, source: 'screen_share' })).toBe(false)
    expect(publishSourceNames([1, 2, 3, 4, 9])).toEqual([
      'camera',
      'microphone',
      'screen_share',
      'screen_share_audio',
      'unknown'
    ])
  })
})
