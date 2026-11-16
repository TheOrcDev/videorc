import { parseRoomPcmFrame, type RoomPcmCommand, type RoomPcmFrame } from '../shared/room-pcm'

type Connection = { host: string; port: number; token: string }
/** One socket, one request credit, no event forwarding and no credentials in preload. */
export class RoomPcmBridge {
  static #owners = new Set<RoomPcmBridge>()
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
  #pending: {
    id: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  } | null = null
  #serial = 0
  #connecting = false
  #timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    private readonly connection: () => Promise<Connection>,
    private readonly enabled: () => boolean,
    private readonly socketFactory: (url: string) => WebSocket = (url) => new WebSocket(url)
  ) {}

  async request(command: RoomPcmCommand): Promise<RoomPcmFrame | null> {
    if (!this.enabled() || this.#closed) throw new Error('PCM test bridge is disabled.')
    if (command.action === 'close') {
      if (command.generation !== this.#generation) throw new Error('Stale PCM generation.')
      this.close()
      return null
    }
    if (this.#pending) throw new Error('PCM request already outstanding.')
    if (command.action === 'open') {
      if (this.#generation !== 0) throw new Error('PCM bridge already opened.')
      this.#generation = command.generation
      RoomPcmBridge.#owners.add(this)
      this.#connecting = true
      let connection: Connection
      try {
        connection = await this.connection()
      } finally {
        this.#connecting = false
        if (this.#closed) RoomPcmBridge.#owners.delete(this)
      }
      if (this.#closed) throw new Error('PCM bridge closed during connection.')
      const socket = this.socketFactory(
        `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
      )
      this.#socket = socket
      socket.onmessage = (event) => {
        if (typeof event.data !== 'string' || event.data.length > 32768) {
          this.close()
          return
        }
        let message: { id?: string; ok?: boolean; payload?: unknown }
        try {
          message = JSON.parse(event.data)
        } catch {
          this.close()
          return
        }
        if (!message || typeof message !== 'object') {
          this.close()
          return
        }
        const pending = this.#pending
        if (!pending || message.id !== pending.id) return
        this.#pending = null
        clearTimeout(this.#timer)
        this.#timer = undefined
        if (message.ok) pending.resolve(message.payload)
        else pending.reject(new Error('Native PCM request refused.'))
      }
      socket.onclose = socket.onerror = () => this.close()
      await new Promise<void>((resolve, reject) => {
        this.#pending = { id: 'connecting', resolve: () => resolve(), reject }
        this.#timer = setTimeout(() => this.close(), 2000)
        socket.onopen = () => {
          clearTimeout(this.#timer)
          this.#timer = undefined
          this.#pending = null
          socket.send(
            JSON.stringify({
              id: 'pcm-events',
              method: 'events.setIncluded',
              params: { events: [] }
            })
          )
          resolve()
        }
      })
    }
    if (command.generation !== this.#generation || !this.#socket || this.#closed)
      throw new Error('Stale or closed PCM generation.')
    const socket = this.#socket
    const result = await new Promise<unknown>((resolve, reject) => {
      const id = `pcm-${++this.#serial}`
      this.#pending = { id, resolve, reject }
      this.#timer = setTimeout(() => this.close(), 2000)
      socket.send(JSON.stringify({ id, method: 'room.pcm.test', params: command }))
    })
    if (this.#closed) throw new Error('PCM bridge closed during pull.')
    return result === null ? null : parseRoomPcmFrame(result, this.#generation)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#timer)
    this.#timer = undefined
    const pending = this.#pending
    this.#pending = null
    pending?.reject(new Error('PCM bridge closed.'))
    const socket = this.#socket
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = null
      socket.onclose = () => {
        this.#socket = null
        RoomPcmBridge.#owners.delete(this)
      }
      socket.close()
      if (socket.readyState === 3) {
        this.#socket = null
        RoomPcmBridge.#owners.delete(this)
      }
    } else if (!this.#connecting) RoomPcmBridge.#owners.delete(this)
  }
}
