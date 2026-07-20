/**
 * Fire-and-forget "state → external call" bridge (effect-elimination plan E4).
 *
 * The render body hands it the latest value (house latest-value pattern); it
 * dedupes by serialized content and invokes the call once, after the commit,
 * per actual change. Replaces the `useEffect(() => send(value), [value])`
 * shape for one-way pushes where the receiver keeps its own state (main
 * process IPC, backend mirrors).
 */
export class RenderSyncedCall<T> {
  private lastSentBody: string | null = null
  private latest: T | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (value: T) => void,
    private readonly debounceMs = 0
  ) {}

  /** Safe to call from a render body: unchanged content is a no-op and the
   * send happens on a post-commit timer. */
  sync(value: T): void {
    const body = JSON.stringify(value)
    if (body === this.lastSentBody) {
      return
    }
    this.latest = value
    this.lastSentBody = body
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.latest !== null) {
          this.send(this.latest)
        }
      }, this.debounceMs)
    }
  }
}
