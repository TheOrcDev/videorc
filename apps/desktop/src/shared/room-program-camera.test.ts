import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ROOM_PROGRAM_CAMERA_FPS,
  ROOM_PROGRAM_CAMERA_FRAME_BYTES,
  ROOM_PROGRAM_CAMERA_HEADER_BYTES,
  ROOM_PROGRAM_CAMERA_HEIGHT,
  ROOM_PROGRAM_CAMERA_PAUSED_SOURCE,
  ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED,
  ROOM_PROGRAM_CAMERA_SOURCE,
  ROOM_PROGRAM_CAMERA_STALE_MS,
  ROOM_PROGRAM_CAMERA_VIEW_SOURCE,
  ROOM_PROGRAM_CAMERA_WIDTH,
  encodeRoomProgramCameraHeader,
  isVideorcCameraLabel,
  parseRoomProgramCameraFrame,
  parseRoomProgramCameraHeader,
  pickRoomCameraDevice,
  roomProgramCameraLine
} from './room-program-camera'

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/room-program-camera.json', import.meta.url),
    'utf8'
  )
) as {
  width: number
  height: number
  fps: number
  headerBytes: number
  frameBytes: number
  staleMs: number
  source: string
  pausedSource: string
  viewSource: string
  encodedOutput: boolean
  header: {
    hex: string
    fields: { generation: number; sequence: number; drawnAtUs: number }
  }
  refusedHeaders: { why: string; hex: string }[]
  labels: { label: string; videorc: boolean }[]
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'))

describe('room program camera contract (plan 249 S23)', () => {
  it('stays disabled in production and matches the shared fixture', () => {
    expect(ROOM_PROGRAM_CAMERA_PRODUCTION_ENABLED).toBe(false)
    expect(ROOM_PROGRAM_CAMERA_WIDTH).toBe(fixture.width)
    expect(ROOM_PROGRAM_CAMERA_HEIGHT).toBe(fixture.height)
    expect(ROOM_PROGRAM_CAMERA_FPS).toBe(fixture.fps)
    expect(ROOM_PROGRAM_CAMERA_HEADER_BYTES).toBe(fixture.headerBytes)
    expect(ROOM_PROGRAM_CAMERA_FRAME_BYTES).toBe(fixture.frameBytes)
    expect(ROOM_PROGRAM_CAMERA_STALE_MS).toBe(fixture.staleMs)
    expect(ROOM_PROGRAM_CAMERA_SOURCE).toBe(fixture.source)
    expect(ROOM_PROGRAM_CAMERA_PAUSED_SOURCE).toBe(fixture.pausedSource)
    expect(ROOM_PROGRAM_CAMERA_VIEW_SOURCE).toBe(fixture.viewSource)
    expect(fixture.encodedOutput).toBe(false)
  })

  it('encodes the fixture header byte for byte and parses it back', () => {
    const bytes = encodeRoomProgramCameraHeader({
      ...fixture.header.fields,
      width: ROOM_PROGRAM_CAMERA_WIDTH,
      height: ROOM_PROGRAM_CAMERA_HEIGHT
    })
    expect(hex(bytes)).toBe(fixture.header.hex)
    expect(parseRoomProgramCameraHeader(bytes)).toEqual({
      ...fixture.header.fields,
      width: ROOM_PROGRAM_CAMERA_WIDTH,
      height: ROOM_PROGRAM_CAMERA_HEIGHT
    })
  })

  it('refuses every fixture header the native parser refuses', () => {
    for (const refused of fixture.refusedHeaders) {
      expect(() => parseRoomProgramCameraHeader(fromHex(refused.hex)), refused.why).toThrow()
    }
    expect(() =>
      encodeRoomProgramCameraHeader({
        generation: 1,
        width: 1920,
        height: 1080,
        sequence: 1,
        drawnAtUs: 0
      })
    ).toThrow()
  })

  it('accepts only an exact frame from the renderer', () => {
    const pixels = new Uint8Array(ROOM_PROGRAM_CAMERA_FRAME_BYTES)
    const frame = { generation: 2, sequence: 1, drawnAtUs: 5, pixels }
    const parsed = parseRoomProgramCameraFrame(frame)
    // The same bytes, never copied (a deep compare of 3.7 MB is slow).
    expect(parsed.pixels).toBe(pixels)
    expect({ ...parsed, pixels: null }).toEqual({ ...frame, pixels: null })
    for (const bad of [
      null,
      { ...frame, pixels: new Uint8Array(4) },
      { ...frame, pixels: Array.from({ length: 4 }) },
      { ...frame, generation: 0 },
      { ...frame, sequence: 0 },
      { ...frame, sequence: 1.5 },
      { ...frame, drawnAtUs: -1 },
      { ...frame, extra: true },
      { generation: 2, sequence: 1, pixels }
    ]) {
      expect(() => parseRoomProgramCameraFrame(bad)).toThrow()
    }
  })

  it('knows Videorc Camera by its label on every platform', () => {
    for (const { label, videorc } of fixture.labels) {
      expect(isVideorcCameraLabel(label), label).toBe(videorc)
    }
  })

  it('never picks Videorc Camera as the room camera', () => {
    const facetime = { deviceId: 'ft', label: 'FaceTime HD Camera' }
    const videorc = { deviceId: 'vc', label: 'Videorc Camera' }
    const usb = { deviceId: 'usb', label: 'USB Camera' }
    expect(pickRoomCameraDevice([videorc, facetime, usb], 'USB Camera')).toBe('usb')
    expect(pickRoomCameraDevice([videorc, facetime], ' facetime hd camera ')).toBe('ft')
    // A Sources camera named Videorc Camera is never opened, and nothing
    // else is opened in its place.
    expect(pickRoomCameraDevice([videorc, facetime], 'Videorc Camera')).toBeUndefined()
    expect(
      pickRoomCameraDevice(
        [{ deviceId: 'vw', label: 'Videorc Camera (Windows Virtual Camera)' }],
        'Videorc Camera (Windows Virtual Camera)'
      )
    ).toBeUndefined()
    expect(pickRoomCameraDevice([videorc, facetime], null)).toBeUndefined()
    expect(pickRoomCameraDevice([videorc, facetime], 'Gone')).toBeUndefined()

    // 0.31.1: Chromium appends the USB model, Sources names the plain device.
    const sony = { deviceId: 'zv', label: 'ZV-E10M2 (054c:0ee8)' }
    expect(pickRoomCameraDevice([videorc, sony], 'ZV-E10M2')).toBe('zv')
    expect(pickRoomCameraDevice([videorc, sony], 'ZV-E10')).toBeUndefined()
    // An exact label wins over a decorated one; two decorated twins are refused.
    const plain = { deviceId: 'plain', label: 'ZV-E10M2' }
    expect(pickRoomCameraDevice([sony, plain], 'ZV-E10M2')).toBe('plain')
    const twin = { deviceId: 'zv2', label: 'ZV-E10M2 (054c:0ee8)' }
    expect(pickRoomCameraDevice([sony, twin], 'ZV-E10M2')).toBeUndefined()
  })

  it('says what the camera shows, never claiming the encoded stream', () => {
    const on = { on: true, cameraOn: true, cameraAvailable: true }
    expect(roomProgramCameraLine({ ...on, on: false })).toBeNull()
    expect(roomProgramCameraLine({ ...on, source: ROOM_PROGRAM_CAMERA_SOURCE })).toBe(
      'Videorc Camera shows this Program preview · Not the encoded stream'
    )
    expect(roomProgramCameraLine({ ...on, source: ROOM_PROGRAM_CAMERA_PAUSED_SOURCE })).toMatch(
      /^Videorc Camera paused/
    )
    expect(roomProgramCameraLine({ ...on, source: null })).toBe('Starting Videorc Camera…')
    expect(roomProgramCameraLine({ ...on, cameraOn: false })).toMatch(/^Turn on Videorc Camera/)
    expect(roomProgramCameraLine({ ...on, cameraAvailable: false })).toMatch(/isn't available/)
  })
})
