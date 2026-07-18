import type {
  BackendConnection,
  ClientCommand,
  ServerEvent,
  ServerResponse
} from '../../shared/backend'
import type {
  BackendEvent,
  BackendEventMap,
  BackendRpcMethod,
  BackendRpcParams,
  BackendRpcResult
} from '../../shared/backend-rpc-contract'

type BackendContractRuntime = typeof import('../../shared/backend-rpc-contract')

let backendContractRuntimePromise: Promise<BackendContractRuntime> | null = null
let backendContractRuntime: BackendContractRuntime | null = null

function loadBackendContractRuntime(): Promise<BackendContractRuntime> {
  backendContractRuntimePromise ??= import('../../shared/backend-rpc-contract').then((runtime) => {
    backendContractRuntime = runtime
    return runtime
  })
  return backendContractRuntimePromise
}

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  socket: WebSocket
  cleanup: () => void
}

type EventHandler = (payload: unknown) => void

type ConnectAttempt = {
  generation: number
  reject: (error: Error) => void
}

export interface BackendRequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export class BackendRequestError extends Error {
  readonly name = 'BackendRequestError'

  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
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
  private connectPromise: Promise<void> | null = null
  private connectAttempt: ConnectAttempt | null = null
  private connectionGeneration = 0
  private closed = false
  private pending = new Map<string, PendingRequest>()
  private handlers = new Map<string, Set<EventHandler>>()
  private requestCounter = 0

  constructor(readonly connection: BackendConnection) {}

  get pendingRequestCount(): number {
    return this.pending.size
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Backend client is closed.'))
    }
    if (this.connectPromise) {
      return this.connectPromise
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve()
    }

    const generation = ++this.connectionGeneration
    let rejectAttempt!: (error: Error) => void
    const attempt = new Promise<void>((resolve, reject) => {
      rejectAttempt = reject
      void this.connectAfterContractLoad(generation).then(resolve, reject)
    })
    this.connectAttempt = { generation, reject: rejectAttempt }
    this.connectPromise = attempt.then(
      () => {
        this.finishConnectAttempt(generation, trackedAttempt)
      },
      (error: unknown) => {
        this.finishConnectAttempt(generation, trackedAttempt)
        throw error
      }
    )
    const trackedAttempt = this.connectPromise
    return trackedAttempt
  }

  private async connectAfterContractLoad(generation: number): Promise<void> {
    try {
      await loadBackendContractRuntime()
    } catch {
      if (!this.isConnectAttemptCurrent(generation)) {
        throw this.inactiveConnectError()
      }
      throw new Error('Backend protocol validator could not load.')
    }
    if (!this.isConnectAttemptCurrent(generation)) {
      throw this.inactiveConnectError()
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }

    return new Promise((resolve, reject) => {
      const url = `ws://${this.connection.host}:${this.connection.port}/ws?token=${encodeURIComponent(
        this.connection.token
      )}`
      const ws = new WebSocket(url)
      let opened = false

      ws.onopen = () => {
        if (!this.isSocketCurrent(ws, generation)) {
          reject(this.inactiveConnectError())
          ws.close()
          return
        }
        opened = true
        resolve()
      }
      ws.onerror = () => {
        const error = new Error('Could not connect to the Rust backend.')
        if (!opened && this.isSocketCurrent(ws, generation)) {
          this.ws = null
          this.connectionGeneration += 1
          reject(error)
          ws.close()
          return
        }
        reject(error)
      }
      ws.onmessage = (event) => {
        if (this.isSocketCurrent(ws, generation)) {
          void this.handleMessage(event.data, ws)
        }
      }
      ws.onclose = () => {
        this.rejectPendingForSocket(ws, new Error('Backend connection closed.'))
        reject(new Error('Backend connection closed.'))
        const wasCurrent = this.ws === ws
        if (wasCurrent) {
          this.ws = null
          this.emit('connection.closed', null)
        }
      }

      if (!this.isConnectAttemptCurrent(generation)) {
        reject(this.inactiveConnectError())
        ws.close()
        return
      }

      this.ws = ws
    })
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.connectionGeneration += 1
    const connectAttempt = this.connectAttempt
    this.connectAttempt = null
    connectAttempt?.reject(new Error('Backend client is closed.'))

    const ws = this.ws
    this.ws = null
    if (!ws) {
      return
    }
    this.rejectPendingForSocket(ws, new Error('Backend connection closed.'))
    ws.close()
    this.emit('connection.closed', null)
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

    if (!backendContractRuntime) {
      return Promise.reject(new Error('Backend protocol validator is not ready.'))
    }
    try {
      backendContractRuntime.validateBackendRpcParams(method, params)
    } catch (error) {
      return Promise.reject(error)
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
        method,
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

  on<TEvent extends BackendEvent>(
    event: TEvent,
    handler: (payload: BackendEventMap[TEvent]) => void
  ): () => void
  on(event: string, handler: EventHandler): () => void
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
    const contract = backendContractRuntime
    if (!contract) {
      this.emit('error', { message: 'Backend protocol validator could not load.' })
      return
    }

    let parsed: ServerResponse | ServerEvent
    try {
      parsed = contract.parseBackendWireMessage(raw)
    } catch {
      this.emit('error', { message: 'Backend sent an invalid websocket message.' })
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
        try {
          pending.resolve(contract.validateBackendRpcResult(pending.method, parsed.payload))
        } catch (error) {
          pending.reject(error)
        }
      } else {
        pending.reject(
          new BackendRequestError(
            parsed.error?.code ?? 'backend-request-failed',
            parsed.error?.message ?? 'Backend request failed.'
          )
        )
      }
      return
    }

    try {
      this.emit(parsed.event, contract.validateBackendEventPayload(parsed.event, parsed.payload))
    } catch {
      this.emit('error', { message: `Backend event "${parsed.event}" failed validation.` })
    }
  }

  /**
   * Strictly typed companion for new/high-risk call sites. Existing request<T>
   * calls remain source-compatible while migrations move onto this method.
   */
  requestTyped<TMethod extends BackendRpcMethod>(
    method: TMethod,
    ...args: undefined extends BackendRpcParams<TMethod>
      ? [params?: BackendRpcParams<TMethod>, options?: BackendRequestOptions]
      : [params: BackendRpcParams<TMethod>, options?: BackendRequestOptions]
  ): Promise<BackendRpcResult<TMethod>> {
    const [params, options = {}] = args
    return this.request<BackendRpcResult<TMethod>>(method, params, options)
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

  private finishConnectAttempt(generation: number, attempt: Promise<void>): void {
    if (this.connectPromise === attempt) {
      this.connectPromise = null
    }
    if (this.connectAttempt?.generation === generation) {
      this.connectAttempt = null
    }
  }

  private isConnectAttemptCurrent(generation: number): boolean {
    return !this.closed && this.connectionGeneration === generation
  }

  private isSocketCurrent(socket: WebSocket, generation: number): boolean {
    return this.isConnectAttemptCurrent(generation) && this.ws === socket
  }

  private inactiveConnectError(): Error {
    return this.closed
      ? new Error('Backend client is closed.')
      : new Error('Backend connection attempt was superseded.')
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
