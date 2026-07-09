export interface NativePreviewMotionReconcilerClock {
  schedule: (callback: () => void, delayMs: number) => unknown
  cancel: (handle: unknown) => void
}

const DEFAULT_CLOCK: NativePreviewMotionReconcilerClock = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** Coalesces geometry telemetry to display cadence while AppKit moves the layer atomically. */
export class NativePreviewMotionReconciler {
  private scheduled = false
  private handle: unknown = null

  constructor(
    private readonly reconcile: () => void,
    private readonly clock: NativePreviewMotionReconcilerClock = DEFAULT_CLOCK,
    private readonly cadenceMs = 16
  ) {}

  request(): void {
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    this.handle = this.clock.schedule(() => {
      this.scheduled = false
      this.handle = null
      this.reconcile()
    }, this.cadenceMs)
  }

  flush(): void {
    if (!this.scheduled) {
      return
    }
    this.clock.cancel(this.handle)
    this.scheduled = false
    this.handle = null
    this.reconcile()
  }

  cancel(): void {
    if (!this.scheduled) {
      return
    }
    this.clock.cancel(this.handle)
    this.scheduled = false
    this.handle = null
  }
}
