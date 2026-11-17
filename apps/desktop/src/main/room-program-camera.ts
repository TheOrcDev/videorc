// Plan 249 S23 (D10): the room's Program preview frames main sends the backend
// for Videorc Camera.
//
// One chunked HTTP upload per room generation on loopback
// (`POST /room-program-camera/frames?token=<admin>&generation=<n>`). Its body
// is frame records: the 40-byte `VRPC` header (`shared/room-program-camera.ts`),
// then exactly 1280 x 720 x 4 bytes of straight RGBA. The upload is the owner:
// while it is open the camera shows the room program (or a black paused
// still); when it ends the camera returns to its Studio source.
//
// Latest wins: a frame is never queued behind one the socket still holds. A
// broken upload is never reopened under the same generation (the backend
// refuses a used one): the uplink reports `closed`, and the renderer opens a
// new generation.

import { request as httpRequest, type ClientRequest } from 'node:http'

import {
  ROOM_PROGRAM_CAMERA_HEIGHT,
  ROOM_PROGRAM_CAMERA_WIDTH,
  encodeRoomProgramCameraHeader,
  type RoomProgramCameraFrame,
  type RoomProgramCameraSendOutcome
} from '../shared/room-program-camera'

export interface RoomProgramUploadConnection {
  host: string
  port: number
  /** The admin token: only main may put pixels on Videorc Camera. */
  token: string
}

/** What the uplink needs of an upload: `http.ClientRequest` in the app, a fake in tests. */
export interface RoomProgramUploadStream {
  write: (chunk: Uint8Array) => boolean
  end: () => void
  destroy: () => void
  readonly writableNeedDrain: boolean
  readonly destroyed: boolean
  on: (event: 'error' | 'close', listener: (error?: Error) => void) => unknown
}

export interface RoomProgramUplinkStats {
  generation: number
  framesSent: number
  framesDroppedBusy: number
  bytesSent: number
  closed: boolean
}

export function openRoomProgramUpload(
  connection: RoomProgramUploadConnection,
  generation: number
): ClientRequest {
  const upload = httpRequest({
    host: connection.host,
    port: connection.port,
    method: 'POST',
    path: `/room-program-camera/frames?token=${encodeURIComponent(connection.token)}&generation=${generation}`,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Transfer-Encoding': 'chunked'
    },
    // One socket for the upload's whole life, never pooled or reused.
    agent: false
  })
  upload.setNoDelay(true)
  // The backend claims the camera when the request arrives, before the first
  // frame: send the headers now.
  upload.flushHeaders()
  // The backend answers when the upload ends; an early answer (401, 403, 409)
  // ends it from that side and surfaces here as `close`.
  upload.on('response', (response) => response.resume())
  return upload
}

/** One room generation's upload. */
export class RoomProgramCameraUplink {
  private upload: RoomProgramUploadStream | null
  private readonly counters = { framesSent: 0, framesDroppedBusy: 0, bytesSent: 0 }

  constructor(
    readonly generation: number,
    connection: RoomProgramUploadConnection,
    open: (
      connection: RoomProgramUploadConnection,
      generation: number
    ) => RoomProgramUploadStream = openRoomProgramUpload,
    private readonly onClosed: () => void = () => {}
  ) {
    const upload = open(connection, generation)
    this.upload = upload
    const retire = (): void => {
      if (this.upload !== upload) return
      this.upload = null
      if (!upload.destroyed) upload.destroy()
      this.onClosed()
    }
    upload.on('error', retire)
    upload.on('close', retire)
  }

  get closed(): boolean {
    return this.upload === null || this.upload.destroyed
  }

  send(frame: RoomProgramCameraFrame): RoomProgramCameraSendOutcome {
    if (frame.generation !== this.generation) return 'closed'
    const upload = this.upload
    if (!upload || upload.destroyed) return 'closed'
    if (upload.writableNeedDrain) {
      this.counters.framesDroppedBusy += 1
      return 'busy'
    }
    const header = encodeRoomProgramCameraHeader({
      generation: frame.generation,
      width: ROOM_PROGRAM_CAMERA_WIDTH,
      height: ROOM_PROGRAM_CAMERA_HEIGHT,
      sequence: frame.sequence,
      drawnAtUs: frame.drawnAtUs
    })
    // Two plain writes, never corked (see html-overlay-frames.ts: a corked
    // chunked request on Electron's Node never emits `drain`).
    upload.write(header)
    upload.write(frame.pixels)
    this.counters.framesSent += 1
    this.counters.bytesSent += header.byteLength + frame.pixels.byteLength
    return 'sent'
  }

  /** End the upload: the camera returns to its Studio source. */
  close(): void {
    const upload = this.upload
    this.upload = null
    if (upload && !upload.destroyed) upload.end()
  }

  stats(): RoomProgramUplinkStats {
    return { generation: this.generation, ...this.counters, closed: this.closed }
  }
}

/** `GET /room-program-camera/inspect?token=<admin>`: the backend feed's evidence. */
export function fetchRoomProgramInspect(
  connection: RoomProgramUploadConnection,
  timeoutMs = 2000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: connection.host,
        port: connection.port,
        method: 'GET',
        path: `/room-program-camera/inspect?token=${encodeURIComponent(connection.token)}`,
        agent: false,
        timeout: timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = []
        let length = 0
        response.on('data', (chunk: Buffer) => {
          length += chunk.length
          // The answer is a few hundred bytes; anything large is not it.
          if (length > 64 * 1024) request.destroy(new Error('Inspection answer is too large.'))
          else chunks.push(chunk)
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Inspection answered ${response.statusCode}.`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => request.destroy(new Error('Inspection timed out.')))
    request.on('error', reject)
    request.end()
  })
}
