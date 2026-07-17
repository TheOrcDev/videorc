import type { LayoutPreset } from '@/lib/backend'

/** The state projection deck keys render. Minimal by design and the ONLY
 * payload remote sockets receive — never widen it with tokens/paths/URLs. */
export interface RemoteSurfaceState {
  sessionState: string
  sessionActive: boolean
  recordEnabled: boolean
  streamEnabled: boolean
  micMuted: boolean
  layoutPreset: LayoutPreset
  activeTakeoverId: string | null
  windows: {
    notes: boolean
    comments: boolean
    preview: boolean
  }
}

export interface RemoteSurfaceDescribe {
  layoutPresets: readonly LayoutPreset[]
  takeovers: { id: string; name: string }[]
  windows: readonly string[]
}

export interface RemoteSurfaceSnapshot {
  state: RemoteSurfaceState
  describe: RemoteSurfaceDescribe
}

interface RemoteSurfaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

/** Coalesce same-commit bursts; deck latency is invisible below ~50ms. */
const PUBLISH_DEBOUNCE_MS = 25
/** Bounded backoff for a transiently failing publish — without it a failed
 * FIRST publish leaves remote.describe empty until unrelated state changes. */
const PUBLISH_RETRY_DELAYS_MS = [1000, 2000, 4000]

/**
 * Pushes the remote-control state projection to the backend so deck keys
 * render backend-confirmed truth.
 *
 * Deliberately NOT a React effect: the studio render body hands it the latest
 * snapshot (`sync`, the same latest-value pattern as the hook's render-synced
 * refs) and it owns the change detection, post-commit debounce, reconnect
 * republish, and bounded retry on its own timeline.
 */
export class RemoteSurfacePublisher {
  private client: RemoteSurfaceClient | null = null
  private connected = false
  private latest: RemoteSurfaceSnapshot | null = null
  private lastPublishedBody: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0

  attach(client: RemoteSurfaceClient): void {
    this.client = client
    this.connected = false
  }

  /** The socket is live: the backend's surface slate is blank, so the last
   * published body no longer counts — republish immediately. */
  markConnected(): void {
    this.connected = true
    this.lastPublishedBody = null
    this.retryAttempt = 0
    this.schedule(0)
  }

  detach(): void {
    this.client = null
    this.connected = false
    this.lastPublishedBody = null
    this.retryAttempt = 0
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Record the latest snapshot and schedule a deduped publish. Safe to call
   * from a render body: it mutates only this object and schedules a timer
   * that fires after the commit; identical snapshots are no-ops, so repeated
   * renders (StrictMode, discarded passes) cannot double-publish.
   */
  sync(snapshot: RemoteSurfaceSnapshot): void {
    this.latest = snapshot
    if (JSON.stringify(snapshot) === this.lastPublishedBody) {
      return
    }
    this.schedule(PUBLISH_DEBOUNCE_MS)
  }

  private schedule(delayMs: number): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    const { client, latest } = this
    if (!client || !this.connected || !latest) {
      return
    }
    const body = JSON.stringify(latest)
    if (body === this.lastPublishedBody) {
      return
    }
    try {
      await client.request('remote.surface.publish', latest)
      this.lastPublishedBody = body
      this.retryAttempt = 0
    } catch (error) {
      if (this.retryAttempt < PUBLISH_RETRY_DELAYS_MS.length) {
        this.schedule(PUBLISH_RETRY_DELAYS_MS[this.retryAttempt])
        this.retryAttempt += 1
        return
      }
      // Out of retries: say so once, then wait for the next change or
      // reconnect. Deck keys keep rendering the last state they saw.
      this.retryAttempt = 0
      console.error('[remote-control] surface publish failed after retries', error)
    }
  }
}
