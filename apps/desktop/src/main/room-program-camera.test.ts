import { describe, expect, it } from 'vitest'

import {
  ROOM_PROGRAM_CAMERA_FRAME_BYTES,
  ROOM_PROGRAM_CAMERA_HEADER_BYTES,
  parseRoomProgramCameraHeader
} from '../shared/room-program-camera'
import { RoomProgramCameraUplink, type RoomProgramUploadStream } from './room-program-camera'

class FakeUpload implements RoomProgramUploadStream {
  chunks: Uint8Array[] = []
  writableNeedDrain = false
  destroyed = false
  ended = false
  private listeners = new Map<string, ((error?: Error) => void)[]>()
  write(chunk: Uint8Array): boolean {
    this.chunks.push(chunk)
    return !this.writableNeedDrain
  }
  end(): void {
    this.ended = true
    this.fire('close')
  }
  destroy(): void {
    this.destroyed = true
  }
  on(event: 'error' | 'close', listener: (error?: Error) => void): unknown {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
    return this
  }
  fire(event: 'error' | 'close', error?: Error): void {
    for (const listener of this.listeners.get(event) ?? []) listener(error)
  }
}

const connection = { host: '127.0.0.1', port: 1, token: 'admin' }
const frame = (generation: number, sequence: number) => ({
  generation,
  sequence,
  drawnAtUs: 10,
  pixels: new Uint8Array(ROOM_PROGRAM_CAMERA_FRAME_BYTES)
})

describe('room program uplink (plan 249 S23)', () => {
  it('opens one upload for its generation and writes a header, then exact pixels', () => {
    const upload = new FakeUpload()
    const opened: number[] = []
    const uplink = new RoomProgramCameraUplink(4, connection, (_connection, generation) => {
      opened.push(generation)
      return upload
    })
    expect(opened).toEqual([4])
    expect(uplink.send(frame(4, 1))).toBe('sent')
    expect(upload.chunks).toHaveLength(2)
    expect(upload.chunks[0]!.byteLength).toBe(ROOM_PROGRAM_CAMERA_HEADER_BYTES)
    expect(parseRoomProgramCameraHeader(upload.chunks[0]!)).toMatchObject({
      generation: 4,
      sequence: 1
    })
    expect(upload.chunks[1]!.byteLength).toBe(ROOM_PROGRAM_CAMERA_FRAME_BYTES)
    expect(uplink.stats()).toMatchObject({ framesSent: 1, closed: false })
  })

  it('drops a frame while the socket holds the last one (latest wins)', () => {
    const upload = new FakeUpload()
    const uplink = new RoomProgramCameraUplink(1, connection, () => upload)
    upload.writableNeedDrain = true
    expect(uplink.send(frame(1, 1))).toBe('busy')
    expect(upload.chunks).toHaveLength(0)
    upload.writableNeedDrain = false
    expect(uplink.send(frame(1, 2))).toBe('sent')
    expect(uplink.stats()).toMatchObject({ framesSent: 1, framesDroppedBusy: 1 })
  })

  it('never writes another generation and never reopens a broken upload', () => {
    const upload = new FakeUpload()
    let closed = 0
    let opens = 0
    const uplink = new RoomProgramCameraUplink(
      2,
      connection,
      () => {
        opens += 1
        return upload
      },
      () => {
        closed += 1
      }
    )
    expect(uplink.send(frame(3, 1))).toBe('closed')
    upload.fire('error', new Error('reset'))
    expect(closed).toBe(1)
    expect(uplink.closed).toBe(true)
    expect(uplink.send(frame(2, 1))).toBe('closed')
    expect(opens).toBe(1)
  })

  it('ends the upload on close without reporting a break', () => {
    const upload = new FakeUpload()
    let closed = 0
    const uplink = new RoomProgramCameraUplink(
      1,
      connection,
      () => upload,
      () => {
        closed += 1
      }
    )
    uplink.close()
    expect(upload.ended).toBe(true)
    expect(closed).toBe(0)
    expect(uplink.send(frame(1, 1))).toBe('closed')
  })
})
