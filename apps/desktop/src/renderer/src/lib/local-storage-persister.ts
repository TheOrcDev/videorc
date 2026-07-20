interface PersisterStorage {
  setItem(key: string, value: string): void
}

/**
 * Persists state slices to localStorage without a React effect.
 *
 * The render body hands it the latest values (house latest-value pattern):
 * an object-identity fast path makes the per-render call free, content dedupe
 * skips no-op writes, and a trailing debounce coalesces bursts — the old
 * effect serialized the full captureConfig synchronously on EVERY change.
 * Pending writes flush on pagehide so a quit never loses the last edit.
 */
export class LocalStoragePersister {
  private readonly lastValue = new Map<string, unknown>()
  private readonly lastWritten = new Map<string, string>()
  private readonly pending = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly storage: PersisterStorage | null = typeof localStorage === 'undefined'
      ? null
      : localStorage,
    private readonly debounceMs = 150
  ) {
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.flush())
    }
  }

  /** Safe to call from a render body: identical object identity is a no-op
   * (the optional `serialize` projection only runs when identity changed),
   * identical serialized content is a no-op, and actual writes happen on a
   * post-commit timer. */
  sync<T>(key: string, value: T, serialize?: (value: T) => unknown): void {
    if (this.lastValue.get(key) === value) {
      return
    }
    this.lastValue.set(key, value)
    const body = JSON.stringify(serialize ? serialize(value) : value)
    if (this.lastWritten.get(key) === body) {
      return
    }
    this.pending.set(key, body)
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.debounceMs)
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [key, body] of [...this.pending]) {
      try {
        this.storage?.setItem(key, body)
        this.lastWritten.set(key, body)
        this.pending.delete(key)
      } catch (error) {
        // Quota failures must be visible; the entry stays pending so the
        // next sync/flush retries instead of silently dropping the write.
        console.error(`[storage] could not persist ${key}`, error)
      }
    }
  }
}
