import { describe, expect, it } from 'vitest'
import fixture from '../../../../protocol-fixtures/room-camera.json'
import {
  FIXTURE_CAMERA,
  ROOM_CAMERA_ROLE,
  ROOM_PROCESSED_CAMERA_ENABLED,
  fixtureCameraRgb,
  logicalSizeFor,
  parseRoomCameraResources
} from './room-camera'
import {
  ROOM_CAMERA_ROLE as FRAME_ROLE,
  ROOM_FRAME,
  ROOM_FRAME_FLAGS,
  cameraAlphaDimensions,
  frameStampBits,
  logicalSizeOfPacked,
  packedWidthFor,
  parseRoomFrameHeader,
  parseRoomFrameReply,
  roomFrameCommand,
  parseRoomFrameCommand
} from './room-frame'

function packed(
  w: number,
  h: number,
  fields: Partial<{ flags: number; pts: bigint; observed: bigint; sequence: bigint }> = {}
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(ROOM_FRAME.headerBytes + packedWidthFor(w) * h * 4)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, ROOM_FRAME.magic, true)
  view.setUint16(4, 1, true)
  view.setUint16(6, fields.flags ?? ROOM_FRAME_FLAGS.packed | ROOM_FRAME_FLAGS.ptsObserved, true)
  view.setUint32(8, 4, true)
  view.setUint32(12, packedWidthFor(w), true)
  view.setUint32(16, h, true)
  view.setUint32(20, 1, true)
  view.setBigUint64(32, 9n, true)
  view.setBigUint64(40, fields.sequence ?? 3n, true)
  view.setBigUint64(48, fields.pts ?? 12_345n, true)
  view.setBigUint64(56, fields.observed ?? 20_000n, true)
  view.setBigUint64(64, 0xffff_ffff_ffff_ffffn, true)
  return bytes
}

describe('processed camera contract (S13b)', () => {
  it('stays disabled and shares one role name with the frame contract', () => {
    expect(ROOM_PROCESSED_CAMERA_ENABLED).toBe(false)
    expect(ROOM_CAMERA_ROLE).toBe(FRAME_ROLE)
    expect(fixture.productionQualified).toBe(false)
    expect(fixture.flags).toEqual(ROOM_FRAME_FLAGS)
    expect(fixture.zones).toEqual(JSON.parse(JSON.stringify(FIXTURE_CAMERA)))
  })

  it('fits the source aspect within S10 limits, never cropping', () => {
    for (const v of fixture.logicalSizes) {
      expect(logicalSizeFor(v.sourceWidth, v.sourceHeight)).toEqual({
        width: v.width,
        height: v.height
      })
      expect(cameraAlphaDimensions(v.width, v.height)).toBe(true)
    }
    expect(logicalSizeFor(0, 10)).toBeNull()
  })

  it('mirrors the native fixture camera pixel for pixel', () => {
    for (const v of fixture.pixels)
      expect(fixtureCameraRgb(v.x, v.y, v.width, v.height, frameStampBits(v.sequence))).toEqual(
        v.rgb
      )
  })

  it('parses a processed frame at its own size with observation-time pts', () => {
    const bytes = packed(554, 414)
    const header = parseRoomFrameHeader(bytes, {
      generation: 9,
      serial: 4,
      processed: { width: 554, height: 414 }
    })
    expect(header).toMatchObject({ ptsObserved: true, width: 1116, height: 414, ptsUs: 12_345 })
    expect(logicalSizeOfPacked(header.width, header.height)).toEqual({ width: 554, height: 414 })
    // The synthetic contract never accepts a processed frame, and vice versa.
    expect(() => parseRoomFrameHeader(bytes, { generation: 9, serial: 4 })).toThrow()
    expect(() =>
      parseRoomFrameHeader(packed(554, 414, { flags: ROOM_FRAME_FLAGS.packed }), {
        processed: { width: 554, height: 414 }
      })
    ).toThrow()
    expect(() =>
      parseRoomFrameHeader(packed(554, 414, { observed: 10n }), {
        processed: { width: 554, height: 414 }
      })
    ).toThrow()
    expect(() => parseRoomFrameHeader(bytes, { processed: { width: 640, height: 360 } })).toThrow()
    const reply = parseRoomFrameReply({ header, pixels: bytes.slice(ROOM_FRAME.headerBytes) }, 9, {
      width: 554,
      height: 414
    })
    expect(reply && 'header' in reply && reply.header.ptsObserved).toBe(true)
    expect(() =>
      parseRoomFrameReply({ header, pixels: bytes.slice(ROOM_FRAME.headerBytes + 4) }, 9)
    ).toThrow()
    expect(() =>
      parseRoomFrameReply({ header: { ...header, ptsObserved: false }, pixels: bytes.slice(96) }, 9)
    ).toThrow()
  })

  it('builds and validates processed commands at a logical size', () => {
    const command = roomFrameCommand('open', 3, 1, undefined, { width: 554, height: 414, fps: 30 })
    expect(parseRoomFrameCommand(command)).toMatchObject({ role: 'host-camera', width: 554 })
    expect(() => parseRoomFrameCommand({ ...command, height: 415 })).toThrow()
    expect(roomFrameCommand('open', 3, 1)).toMatchObject({ role: 'host-camera-test', width: 640 })
  })

  it('reports resources with a logical size or none, never half', () => {
    const resources = {
      nativeSources: 0,
      nativeLeases: 0,
      sockets: 0,
      ipcRequests: 0,
      timers: 0,
      logicalWidth: null,
      logicalHeight: null,
      keptForRoom: false,
      lentToBrowserRoom: false,
      fixture: false
    }
    expect(parseRoomCameraResources(resources)).toEqual(resources)
    expect(() => parseRoomCameraResources({ ...resources, logicalWidth: 640 })).toThrow()
    expect(() => parseRoomCameraResources({ ...resources, keptForRoom: 'yes' })).toThrow()
  })
})
