/** A refresh either ran or was deferred because capture is active. Deferral is
 * an expected answer, not a failure, so it resolves rather than rejects. */
export type AccountRefreshOutcome<T> =
  { outcome: 'refreshed'; snapshot: T } | { outcome: 'deferred' }

/** Main-process ownership for periodic product-account maintenance. It keeps
 * refresh off the renderer's live-control WebSocket, coalesces focus/timer
 * bursts, and refuses to start new network maintenance during capture. */
export class AccountRefreshBroker<T> {
  private inFlight: Promise<AccountRefreshOutcome<T>> | null = null

  constructor(
    private readonly captureIsActive: () => boolean,
    private readonly request: () => Promise<T>
  ) {}

  refresh(): Promise<AccountRefreshOutcome<T>> {
    if (this.captureIsActive()) {
      return Promise.resolve({ outcome: 'deferred' })
    }
    if (this.inFlight) return this.inFlight

    const request = this.request().then((snapshot): AccountRefreshOutcome<T> => ({
      outcome: 'refreshed',
      snapshot
    }))
    this.inFlight = request
    const clear = (): void => {
      if (this.inFlight === request) this.inFlight = null
    }
    void request.then(clear, clear)
    return request
  }
}
