import {
  ROOM_FRAME,
  ROOM_FRAME_MESSAGE_BYTES,
  parseRoomFrameHeader,
  parseRoomFrameReply,
  type RoomFrameCommand,
  type RoomFrameReply
} from '../shared/room-frame'

type Connection = { host: string; port: number; token: string }
type Pending = {
  id: string
  serial: number
  resolve: (value: RoomFrameReply) => void
  reject: (error: Error) => void
}

/**
 * Plan 249 S13a: one private admin socket, one request credit, no event
 * forwarding and no credentials in preload. A frame arrives as one binary
 * message whose complete header and exact length are validated before the
 * pixels are copied out of the socket buffer. Closing the socket drops the
 * connection-owned native source and every lease it holds.
 */
export class RoomFrameBridge {
  static #owners = new Set<RoomFrameBridge>()
  static resources(): { sockets: number; ipcRequests: number; timers: number } {
    const owners = [...this.#owners]
    return {
      sockets: owners.filter((o) => o.#socket !== null && o.#socket.readyState !== 3).length,
      ipcRequests: owners.filter((o) => o.#pending !== null || o.#connecting).length,
      timers: owners.filter((o) => o.#timer !== undefined).length
    }
  }
  #socket: WebSocket | null = null
  #generation = 0
  #closed = false
  #pending: Pending | null = null
  #connecting = false
  #timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly connection: () => Promise<Connection>,
    private readonly enabled: () => boolean,
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)
  ) {}

  async request(command: RoomFrameCommand): Promise<RoomFrameReply> {
    if (!this.enabled() || this.#closed) throw new Error('Frame test bridge is disabled.')
    if (this.#pending) throw new Error('Frame request already outstanding.')
    if (command.action === 'open') {
      if (this.#generation !== 0) throw new Error('Frame bridge already opened.')
      this.#generation = command.generation
      RoomFrameBridge.#owners.add(this)
      await this.#connect()
    }
    if (command.generation !== this.#generation || !this.#socket || this.#closed)
      throw new Error('Stale or closed frame generation.')
    const socket = this.#socket
    const result = await new Promise<RoomFrameReply>((resolve, reject) => {
      const id = `frame-${command.serial}`
      this.#pending = { id, serial: command.serial, resolve, reject }
      this.#timer = setTimeout(() => this.close(), ROOM_FRAME.requestTimeoutMs)
      socket.send(JSON.stringify({ id, method: 'room.frame.test', params: command }))
    })
    if (command.action === 'close') this.close()
    else if (this.#closed) throw new Error('Frame bridge closed during request.')
    return result
  }

  async #connect(): Promise<void> {
    this.#connecting = true
    let connection: Connection
    try {
      connection = await this.connection()
    } finally {
      this.#connecting = false
      if (this.#closed) RoomFrameBridge.#owners.delete(this)
    }
    if (this.#closed) throw new Error('Frame bridge closed during connection.')
    const socket = this.socketFactory(
      `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    )
    socket.binaryType = 'arraybuffer'
    this.#socket = socket
    socket.onmessage = (event) => this.#message(event.data)
    socket.onclose = socket.onerror = () => this.close()
    await new Promise<void>((resolve, reject) => {
      this.#pending = { id: 'connecting', serial: -1, resolve: () => resolve(), reject }
      this.#timer = setTimeout(() => this.close(), ROOM_FRAME.requestTimeoutMs)
      socket.onopen = () => {
        clearTimeout(this.#timer)
        this.#timer = undefined
        this.#pending = null
        socket.send(
          JSON.stringify({
            id: 'frame-events',
            method: 'events.setIncluded',
            params: { events: [] }
          })
        )
        resolve()
      }
    })
  }

  #settle(): void {
    this.#pending = null
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #message(data: unknown): void {
    const pending = this.#pending
    if (data instanceof ArrayBuffer) {
      // Unsolicited or oversized binary is a protocol violation, not a frame.
      if (!pending || pending.serial < 0 || data.byteLength !== ROOM_FRAME_MESSAGE_BYTES) {
        this.close()
        return
      }
      const bytes = new Uint8Array(data)
      let header
      try {
        header = parseRoomFrameHeader(bytes, {
          generation: this.#generation,
          serial: pending.serial
        })
      } catch {
        this.close()
        return
      }
      this.#settle()
      // An exact-size copy: structured clone of a view would ship its whole buffer.
      pending.resolve({ header, pixels: bytes.slice(ROOM_FRAME.headerBytes) })
      return
    }
    if (typeof data !== 'string' || data.length > 4096) {
      this.close()
      return
    }
    let message: { id?: string; ok?: boolean; payload?: unknown }
    try {
      message = JSON.parse(data)
    } catch {
      this.close()
      return
    }
    if (!message || typeof message !== 'object') {
      this.close()
      return
    }
    if (!pending || message.id !== pending.id) return
    this.#settle()
    if (!message.ok) {
      pending.reject(new Error('Native frame request refused.'))
      return
    }
    try {
      pending.resolve(parseRoomFrameReply(message.payload ?? null, this.#generation))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error('Invalid frame reply.'))
      this.close()
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    const pending = this.#pending
    this.#pending = null
    pending?.reject(new Error('Frame bridge closed.'))
    const socket = this.#socket
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = null
      socket.onclose = () => {
        this.#socket = null
        RoomFrameBridge.#owners.delete(this)
      }
      socket.close()
      if (socket.readyState === 3) {
        this.#socket = null
        RoomFrameBridge.#owners.delete(this)
      }
    } else if (!this.#connecting) RoomFrameBridge.#owners.delete(this)
  }
}
