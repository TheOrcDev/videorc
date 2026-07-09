export interface NativePreviewLatestPumpOptions<T> {
  apply: (value: T) => void | Promise<void>
  onSuperseded?: (value: T) => void
  onError?: (error: unknown) => void
}

/**
 * Serializes native preview handoffs without allowing an event-loop backlog to
 * become a mutation-queue backlog. One value may be applying and one newest
 * value may wait; replacing that waiter accounts the displaced frame before it
 * ever reaches AppKit/Metal.
 */
export class NativePreviewLatestPump<T> {
  private active = false
  private pending: T | null = null
  private readonly idleWaiters = new Set<() => void>()

  constructor(private readonly options: NativePreviewLatestPumpOptions<T>) {}

  get requestDepth(): number {
    return Number(this.active) + Number(this.pending !== null)
  }

  enqueue(value: T): void {
    if (!this.active) {
      this.start(value)
      return
    }
    if (this.pending !== null) {
      this.options.onSuperseded?.(this.pending)
    }
    this.pending = value
  }

  cancelPending(): T | null {
    const pending = this.pending
    this.pending = null
    return pending
  }

  waitForIdle(): Promise<void> {
    if (!this.active) {
      return Promise.resolve()
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  private start(value: T): void {
    this.active = true
    const apply = async (): Promise<void> => {
      await this.options.apply(value)
    }
    void apply()
      .catch((error: unknown) => this.options.onError?.(error))
      .finally(() => {
        const next = this.pending
        this.pending = null
        if (next !== null) {
          this.start(next)
          return
        }
        this.active = false
        for (const resolve of this.idleWaiters) {
          resolve()
        }
        this.idleWaiters.clear()
      })
  }
}
