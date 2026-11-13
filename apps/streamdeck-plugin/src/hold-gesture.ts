// A tap or a hold on one key (plan 230): a tap acts on release, a hold acts
// once the key has been down for HOLD_MS, while it is still down.

export const HOLD_MS = 500

export interface HoldGesture {
  down(key: string): void
  up(key: string): void
  /** The key left the deck mid-press: its release will never come. */
  cancel(key: string): void
}

export function createHoldGesture({
  onTap,
  onHold
}: {
  onTap: (key: string) => void
  onHold: (key: string) => void
}): HoldGesture {
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  return {
    down(key) {
      if (pending.has(key)) return
      pending.set(
        key,
        setTimeout(() => {
          pending.delete(key)
          onHold(key)
        }, HOLD_MS)
      )
    },
    up(key) {
      const timer = pending.get(key)
      if (!timer) return
      clearTimeout(timer)
      pending.delete(key)
      onTap(key)
    },
    cancel(key) {
      clearTimeout(pending.get(key))
      pending.delete(key)
    }
  }
}
