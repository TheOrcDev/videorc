/** Main-process ownership for periodic product-account maintenance. It keeps
 * refresh off the renderer's live-control WebSocket, coalesces focus/timer
 * bursts, and refuses to start new network maintenance during capture. */
export class AccountRefreshBroker<T> {
  private inFlight: Promise<T> | null = null

  constructor(
    private readonly captureIsActive: () => boolean,
    private readonly request: () => Promise<T>
  ) {}

  refresh(): Promise<T> {
    if (this.captureIsActive()) {
      return Promise.reject(
        new Error('Account maintenance is deferred until the live session is idle.')
      )
    }
    if (this.inFlight) return this.inFlight

    const request = this.request()
    this.inFlight = request
    const clear = (): void => {
      if (this.inFlight === request) this.inFlight = null
    }
    void request.then(clear, clear)
    return request
  }
}
