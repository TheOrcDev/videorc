// Local connection to the Videorc backend's remote-control surface.
//
// Pairing is same-machine: the app writes a 0600 discovery file next to its
// database when Remote Control is enabled in Settings. This client watches
// that file, connects with the token, keeps a live state snapshot for key
// rendering, and reconnects with backoff when the app restarts, the token
// rotates, or the surface is disabled.

import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

export interface RemoteState {
  sessionState?: string
  sessionActive?: boolean
  recordEnabled?: boolean
  streamEnabled?: boolean
  micMuted?: boolean
  layoutPreset?: string
  activeTakeoverId?: string | null
  windows?: { notes?: boolean; comments?: boolean; preview?: boolean }
}

export interface RemoteDescribe {
  layoutPresets?: string[]
  takeovers?: Array<{ id: string; name: string }>
  windows?: string[]
}

interface Discovery {
  host: string
  port: number
  token: string
  protocol: number
}

const RECONNECT_DELAY_MS = 2_000
/** An intent that neither acked nor failed within this window counts as
 * failed — the deck key must never hang waiting for feedback. */
const INTENT_ACK_TIMEOUT_MS = 5_000

export function defaultDiscoveryPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Videorc', 'remote-control.json')
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
      'Videorc',
      'remote-control.json'
    )
  }
  return join(homedir(), '.config', 'Videorc', 'remote-control.json')
}

export function readDiscovery(path: string): Discovery | null {
  try {
    if (!existsSync(path)) {
      return null
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Discovery>
    if (!parsed.port || !parsed.token) {
      return null
    }
    return {
      host: parsed.host ?? '127.0.0.1',
      port: parsed.port,
      token: parsed.token,
      protocol: parsed.protocol ?? 1
    }
  } catch {
    return null
  }
}

/**
 * Events: `state` (RemoteState), `describe` (RemoteDescribe), `connected`,
 * `disconnected`.
 */
export class VideorcClient extends EventEmitter {
  state: RemoteState | null = null
  describe: RemoteDescribe | null = null
  connected = false

  private ws: WebSocket | null = null
  private nextRequestId = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false
  /** Intent sends awaiting their ServerResponse, keyed by request id. */
  private pendingRequests = new Map<string, (ok: boolean) => void>()
  /** Admitted intents awaiting the renderer's remote.ack, keyed by intentId. */
  private pendingAcks = new Map<string, (ok: boolean) => void>()

  constructor(private readonly discoveryPath: string = defaultDiscoveryPath()) {
    super()
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }

  /**
   * Resolves with the END-TO-END outcome: false when the backend rejects the
   * intent (invalid, debounced, remote control unavailable), when the
   * renderer's ack reports failure, on disconnect, or on timeout. Deck keys
   * render the result — a rejected press must never look like success.
   */
  sendIntent(intent: Record<string, unknown>): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false)
    }
    this.nextRequestId += 1
    const requestId = `sd-${this.nextRequestId}`
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => settle(false), INTENT_ACK_TIMEOUT_MS)
      const settle = (ok: boolean): void => {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        resolve(ok)
      }
      this.pendingRequests.set(requestId, settle)
    })
    this.ws.send(
      JSON.stringify({
        id: requestId,
        method: 'remote.intent',
        params: intent
      })
    )
    return result
  }

  private settleAllPending(ok: boolean): void {
    for (const settle of [...this.pendingRequests.values(), ...this.pendingAcks.values()]) {
      settle(ok)
    }
    this.pendingRequests.clear()
    this.pendingAcks.clear()
  }

  private connect(): void {
    const discovery = readDiscovery(this.discoveryPath)
    if (!discovery) {
      this.scheduleReconnect()
      return
    }
    const url = `ws://${discovery.host}:${discovery.port}/ws?token=${encodeURIComponent(discovery.token)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.on('open', () => {
      this.connected = true
      this.emit('connected')
      this.nextRequestId += 1
      ws.send(JSON.stringify({ id: `sd-${this.nextRequestId}`, method: 'remote.describe' }))
    })
    ws.on('message', (raw) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        return
      }
      // JSON.parse('null') succeeds; anything non-object would throw below
      // and take the plugin process down with it.
      if (typeof parsed !== 'object' || parsed === null) {
        return
      }
      const message = parsed as {
        id?: string
        ok?: boolean
        event?: string
        payload?: {
          describe?: RemoteDescribe
          state?: RemoteState
          intentId?: string
          accepted?: boolean
          ok?: boolean
        } & Record<string, unknown>
      }
      if (message.event === 'remote.state') {
        this.state = message.payload as RemoteState
        this.emit('state', this.state)
        return
      }
      // The renderer executed (or refused) an admitted intent.
      if (message.event === 'remote.ack') {
        const intentId = message.payload?.intentId
        if (intentId) {
          this.pendingAcks.get(intentId)?.(message.payload?.ok === true)
          this.pendingAcks.delete(intentId)
        }
        return
      }
      // ServerResponse shape: {id, ok, payload}. Settle intent sends: a
      // rejected admission fails now; an accepted one waits for remote.ack.
      if (message.id && this.pendingRequests.has(message.id)) {
        const settle = this.pendingRequests.get(message.id)
        if (message.ok === false || message.payload?.accepted === false || !settle) {
          settle?.(false)
        } else if (message.payload?.intentId) {
          this.pendingRequests.delete(message.id)
          this.pendingAcks.set(message.payload.intentId, settle)
        } else {
          settle(true)
        }
        return
      }
      if (message.payload?.describe !== undefined || message.payload?.state !== undefined) {
        if (message.payload.describe) {
          this.describe = message.payload.describe
          this.emit('describe', this.describe)
        }
        if (message.payload.state) {
          this.state = message.payload.state
          this.emit('state', this.state)
        }
      }
    })
    const onGone = (): void => {
      if (this.ws === ws) {
        this.ws = null
        this.settleAllPending(false)
        if (this.connected) {
          this.connected = false
          this.emit('disconnected')
        }
        this.scheduleReconnect()
      }
    }
    ws.on('close', onGone)
    ws.on('error', onGone)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) {
        this.connect()
      }
    }, RECONNECT_DELAY_MS)
  }
}
