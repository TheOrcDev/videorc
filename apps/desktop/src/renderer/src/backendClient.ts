import type {
  BackendConnection,
  ClientCommand,
  ServerEvent,
  ServerResponse
} from '../../shared/backend'

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  socket: WebSocket
  cleanup: () => void
}

type EventHandler = (payload: unknown) => void

export interface BackendRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const METHOD_REQUEST_TIMEOUT_MS: Readonly<Record<string, number>> = {
  'preview.surface.present': 5_000,
  'preview.surface.status': 5_000,
  'compositor.status': 10_000,
  'diagnostics.stats': 10_000,
  'devices.list': 30_000,
  'session.start': 120_000,
  'session.stop': 120_000,
  'session.remux_mp4': 10 * 60_000,
  'sessions.import': 10 * 60_000,
  'repair.repair_file': 10 * 60_000,
  'ai.run_post_recording': 30 * 60_000,
  'ai.publish_pack.export': 30 * 60_000
}

export function backendRequestTimeoutMs(method: string): number {
  return METHOD_REQUEST_TIMEOUT_MS[method] ?? DEFAULT_REQUEST_TIMEOUT_MS
}

export class BackendClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private handlers = new Map<string, Set<EventHandler>>()
  private requestCounter = 0

  constructor(private readonly connection: BackendConnection) {}

  get pendingRequestCount(): number {
    return this.pending.size
  }

  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      const url = `ws://${this.connection.host}:${this.connection.port}/ws?token=${encodeURIComponent(
        this.connection.token
      )}`
      const ws = new WebSocket(url)
      this.ws = ws

      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('Could not connect to the Rust backend.'))
      ws.onmessage = (event) => this.handleMessage(event.data, ws)
      ws.onclose = () => {
        this.rejectPendingForSocket(ws, new Error('Backend connection closed.'))
        if (this.ws === ws) {
          this.ws = null
        }
        this.emit('connection.closed', null)
      }
    })
  }

  close(): void {
    const ws = this.ws
    if (!ws) {
      return
    }
    this.rejectPendingForSocket(ws, new Error('Backend connection closed.'))
    ws.close()
    this.ws = null
  }

  request<TPayload>(
    method: string,
    params?: unknown,
    options: BackendRequestOptions = {}
  ): Promise<TPayload> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Backend WebSocket is not connected.'))
    }
    if (options.signal?.aborted) {
      return Promise.reject(abortError(method))
    }

    const id = `renderer-${Date.now()}-${++this.requestCounter}`
    const command: ClientCommand = { id, method, params }
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs, backendRequestTimeoutMs(method))

    return new Promise((resolve, reject) => {
      let abortHandler: (() => void) | undefined
      const timeoutId = setTimeout(() => {
        this.rejectPending(
          id,
          new Error(`Backend request "${method}" timed out after ${timeoutMs}ms.`)
        )
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timeoutId)
        if (abortHandler && options.signal) {
          options.signal.removeEventListener('abort', abortHandler)
        }
      }
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        socket: ws,
        cleanup
      })

      if (options.signal) {
        abortHandler = () => this.rejectPending(id, abortError(method))
        options.signal.addEventListener('abort', abortHandler, { once: true })
        if (options.signal.aborted) {
          abortHandler()
          return
        }
      }

      try {
        ws.send(JSON.stringify(command))
      } catch (error) {
        this.rejectPending(id, sendError(method, error))
      }
    })
  }

  on(event: string, handler: EventHandler): () => void {
    const handlers = this.handlers.get(event) ?? new Set<EventHandler>()
    handlers.add(handler)
    this.handlers.set(event, handlers)

    return () => {
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.handlers.delete(event)
      }
    }
  }

  private handleMessage(raw: string, socket: WebSocket): void {
    let parsed: ServerResponse | ServerEvent
    try {
      parsed = JSON.parse(raw) as ServerResponse | ServerEvent
    } catch {
      this.emit('error', { message: 'Backend sent invalid JSON.' })
      return
    }

    if ('id' in parsed) {
      const pending = this.pending.get(parsed.id)
      if (!pending || pending.socket !== socket) {
        return
      }

      this.pending.delete(parsed.id)
      pending.cleanup()
      if (parsed.ok) {
        pending.resolve(parsed.payload)
      } else {
        pending.reject(new Error(parsed.error?.message ?? 'Backend request failed.'))
      }
      return
    }

    this.emit(parsed.event, parsed.payload)
  }

  private rejectPending(id: string, error: Error): void {
    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.pending.delete(id)
    pending.cleanup()
    pending.reject(error)
  }

  private rejectPendingForSocket(socket: WebSocket, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) {
        continue
      }
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(error)
    }
  }

  private emit(event: string, payload: unknown): void {
    const handlers = this.handlers.get(event)
    if (!handlers) {
      return
    }

    for (const handler of handlers) {
      handler(payload)
    }
  }
}

function normalizeTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function abortError(method: string): Error {
  const error = new Error(`Backend request "${method}" was cancelled.`)
  error.name = 'AbortError'
  return error
}

function sendError(method: string, reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason)
  return new Error(`Could not send backend request "${method}": ${detail}`)
}
