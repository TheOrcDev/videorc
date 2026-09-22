import { randomUUID } from 'node:crypto'
import type { BackendConnection, CompositorFrameReady } from '../shared/backend'
import {
  parseBackendWireMessage,
  validateCompositorFrameReadyPayload
} from '../shared/backend-rpc-contract'

type Connection = Pick<BackendConnection, 'host' | 'port' | 'token'>

/** A frame transport failure does not imply that the native presenter failed. */
export class NativePreviewFrameLeaseError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'NativePreviewFrameLeaseError'
  }
}

/** One connection, one retained frame, and no queued acquisitions. The backend
 * releases the frame on the matching release or when this connection closes. */
export class NativePreviewFrameLeaseClient {
  private socket: WebSocket | null = null
  private connection: Connection | null = null
  private ready: Promise<void> | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private pending: {
    id: string
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  } | null = null
  private active = false

  constructor(
    private readonly getConnection: () => Connection | null,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
    private readonly timeoutMs = 1000
  ) {}

  async withFrame<T>(
    request: { runId: string; sceneRevision?: number },
    present: (frame: CompositorFrameReady) => Promise<T>
  ): Promise<{ frame: CompositorFrameReady; result: T } | null> {
    if (this.active) return null
    this.active = true
    const leaseId = randomUUID()
    let acquired = false
    let presentationFailed = false
    let result: { frame: CompositorFrameReady; result: T } | null = null
    let failure: { error: unknown } | null = null
    try {
      await this.connect()
      const payload = await this.request('preview.surface.frame.acquire', { ...request, leaseId })
      if (payload !== null) {
        acquired = true
        const frame = validateCompositorFrameReadyPayload(payload)
        if (frame.runId !== request.runId || frame.frameSceneRevision !== request.sceneRevision) {
          throw new Error('Preview frame lease returned a different run or scene.')
        }
        try {
          result = { frame, result: await present(frame) }
        } catch (error) {
          presentationFailed = true
          throw error
        }
      }
    } catch (error) {
      failure = { error: presentationFailed ? error : new NativePreviewFrameLeaseError(error) }
    } finally {
      try {
        if (acquired) await this.release(leaseId)
      } catch (error) {
        // Preserve a presenter failure even if releasing its frame also fails.
        // The main process still needs to retire that failed presenter.
        if (!presentationFailed) failure = { error: new NativePreviewFrameLeaseError(error) }
      } finally {
        this.active = false
      }
    }
    if (failure) throw failure.error
    return result
  }

  private async release(leaseId: string): Promise<void> {
    try {
      if ((await this.request('preview.surface.frame.release', { leaseId })) !== true) {
        throw new Error('Preview frame release was not acknowledged.')
      }
    } catch (error) {
      const failure = new NativePreviewFrameLeaseError(error)
      this.disconnect(failure)
      throw failure
    }
  }

  private connect(): Promise<void> {
    const connection = this.getConnection()
    if (!connection) return Promise.reject(new Error('Preview frame connection is unavailable.'))
    if (
      this.connection?.host === connection.host &&
      this.connection.port === connection.port &&
      this.connection.token === connection.token &&
      this.ready
    )
      return this.ready
    this.disconnect(new Error('Preview frame connection changed.'))
    this.connection = connection
    const socket = this.createSocket(
      `ws://${connection.host}:${connection.port}/ws?token=${encodeURIComponent(connection.token)}`
    )
    this.socket = socket
    this.ready = new Promise<void>((resolve, reject) => {
      this.rejectReady = reject
      const timer = setTimeout(
        () => this.disconnect(new Error('Preview frame connection timed out.')),
        this.timeoutMs
      )
      const clear = (): void => {
        clearTimeout(timer)
        this.rejectReady = null
      }
      socket.onopen = () => {
        if (this.socket !== socket) return
        clear()
        socket.send(
          JSON.stringify({
            id: 'frame-lease-events',
            method: 'events.setIncluded',
            params: { events: [] }
          })
        )
        resolve()
      }
      socket.onclose = socket.onerror = () => {
        clearTimeout(timer)
        if (this.socket === socket) this.disconnect(new Error('Preview frame connection closed.'))
      }
      socket.onmessage = (event) => {
        if (this.socket !== socket || typeof event.data !== 'string') return
        try {
          const message = parseBackendWireMessage(event.data)
          if (!('id' in message) || message.id !== this.pending?.id) return
          const pending = this.pending
          this.pending = null
          if (message.ok) pending.resolve(message.payload)
          else pending.reject(new Error('Preview frame lease request was rejected.'))
        } catch {
          this.disconnect(new Error('Invalid preview frame lease response.'))
        }
      }
    })
    return this.ready
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== 1 || this.pending) {
      return Promise.reject(new Error('Preview frame connection is not ready.'))
    }
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.disconnect(new Error('Preview frame lease request timed out.')),
        this.timeoutMs
      )
      const id = randomUUID()
      this.pending = {
        id,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      }
      try {
        socket.send(JSON.stringify({ id, method, params }))
      } catch {
        this.disconnect(new Error('Preview frame lease request could not be sent.'))
      }
    })
  }

  private disconnect(error: Error): void {
    const socket = this.socket
    this.socket = null
    this.connection = null
    this.ready = null
    this.rejectReady?.(error)
    this.rejectReady = null
    this.pending?.reject(error)
    this.pending = null
    try {
      socket?.close()
    } catch {
      /* Already closed. */
    }
  }
}
