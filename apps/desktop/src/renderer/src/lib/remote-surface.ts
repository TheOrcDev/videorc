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

export type RemoteSurfaceValues = readonly [
  sessionState: string,
  sessionActive: boolean,
  recordEnabled: boolean,
  streamEnabled: boolean,
  micMuted: boolean,
  layoutPreset: LayoutPreset,
  activeTakeoverId: string | null,
  notesOpen: boolean,
  commentsOpen: boolean,
  previewOpen: boolean,
  layoutPresets: readonly LayoutPreset[],
  takeovers: { id: string; name: string }[]
]

function snapshotFromValues(values: RemoteSurfaceValues): RemoteSurfaceSnapshot {
  return {
    state: {
      sessionState: values[0],
      sessionActive: values[1],
      recordEnabled: values[2],
      streamEnabled: values[3],
      micMuted: values[4],
      layoutPreset: values[5],
      activeTakeoverId: values[6],
      windows: { notes: values[7], comments: values[8], preview: values[9] }
    },
    describe: {
      layoutPresets: values[10],
      takeovers: values[11],
      windows: ['notes', 'comments', 'preview']
    }
  }
}

interface RemoteSurfaceClient {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface RemoteIntentContext {
  client: RemoteSurfaceClient
  sessionActive: boolean
  streamEnabled: boolean
  startSession: () => Promise<boolean>
  stopSession: () => Promise<boolean>
  setMicrophoneMuted: (mode: 'mute' | 'unmute' | 'toggle') => Promise<boolean>
  knownLayoutPresets: readonly LayoutPreset[]
  applyLayoutPreset: (layoutPreset: LayoutPreset) => Promise<boolean>
  hasTakeover: (assetId: string) => boolean
  activateTakeover: (assetId: string) => Promise<boolean>
  clearTakeover: () => Promise<boolean>
  openWindow: (name: string) => Promise<boolean>
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

  syncValues(values: RemoteSurfaceValues): void {
    this.sync(snapshotFromValues(values))
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

/** Executes a remote intent through the Studio's existing action handlers. */
export async function executeRemoteIntent(
  payload: unknown,
  context: RemoteIntentContext
): Promise<void> {
  const envelope = payload as {
    intentId?: string
    intent?: { kind?: string } & Record<string, unknown>
  } | null
  const intentId = envelope?.intentId
  const intent = envelope?.intent
  if (!intentId || !intent?.kind) return

  const ack = async (ok: boolean, message?: string): Promise<void> => {
    try {
      await context.client.request('remote.intent.ack', {
        intentId,
        ok,
        ...(message ? { message } : {})
      })
    } catch {
      // The remote client also observes state; a lost ack is non-fatal.
    }
  }

  try {
    switch (intent.kind) {
      case 'recordStart':
        if (context.sessionActive) return void (await ack(false, 'A session is already active.'))
        return void ((await context.startSession())
          ? await ack(true)
          : await ack(false, 'The capture session did not start. Check Studio for details.'))
      case 'recordStop':
      case 'streamStop':
        if (!context.sessionActive) return void (await ack(false, 'No active session.'))
        return void ((await context.stopSession())
          ? await ack(true)
          : await ack(false, 'The active session did not stop. Check Studio for details.'))
      case 'recordToggle': {
        const committed = context.sessionActive
          ? await context.stopSession()
          : await context.startSession()
        return void (committed
          ? await ack(true)
          : await ack(false, 'The session toggle was not committed. Check Studio for details.'))
      }
      case 'streamStart':
        if (!context.streamEnabled) {
          return void (await ack(false, 'Enable streaming in the Studio first.'))
        }
        if (context.sessionActive) return void (await ack(false, 'A session is already active.'))
        return void ((await context.startSession())
          ? await ack(true)
          : await ack(
              false,
              'The stream did not start. Complete any required confirmation in Studio.'
            ))
      case 'micMute':
      case 'micUnmute':
      case 'micToggle': {
        const applied = await context.setMicrophoneMuted(
          intent.kind === 'micToggle' ? 'toggle' : intent.kind === 'micMute' ? 'mute' : 'unmute'
        )
        if (!applied) {
          return void (await ack(false, 'The microphone change was not applied.'))
        }
        return void (await ack(true))
      }
      case 'sceneApply': {
        const layoutPreset = intent.layoutPreset as LayoutPreset | undefined
        if (!layoutPreset) {
          return void (await ack(false, 'Only layoutPreset scene switches are supported.'))
        }
        if (!(context.knownLayoutPresets as readonly string[]).includes(layoutPreset)) {
          return void (await ack(false, `Unknown layout preset "${layoutPreset}".`))
        }
        const committed = await context.applyLayoutPreset(layoutPreset)
        if (!committed) {
          return void (await ack(false, 'The layout change was not committed.'))
        }
        return void (await ack(true))
      }
      case 'takeoverShow': {
        const assetId = intent.assetId as string | undefined
        if (!assetId || !context.hasTakeover(assetId)) {
          return void (await ack(false, 'No takeover with that id.'))
        }
        const activated = await context.activateTakeover(assetId)
        if (!activated) {
          return void (await ack(false, 'The takeover was not activated.'))
        }
        return void (await ack(true))
      }
      case 'takeoverHide': {
        const cleared = await context.clearTakeover()
        if (!cleared) {
          return void (await ack(false, 'The takeover was not cleared.'))
        }
        return void (await ack(true))
      }
      case 'windowFront': {
        const windowName = intent.window as string | undefined
        if (!windowName || !(await context.openWindow(windowName))) {
          return void (await ack(false, `Unknown window "${windowName}".`))
        }
        return void (await ack(true))
      }
      default:
        return void (await ack(false, `Unsupported intent "${intent.kind}".`))
    }
  } catch (error) {
    await ack(false, error instanceof Error ? error.message : 'Intent failed.')
  }
}
