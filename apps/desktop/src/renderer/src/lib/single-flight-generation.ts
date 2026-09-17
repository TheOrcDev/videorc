export type GenerationIsCurrent = () => boolean

export type LatestRequestToken = symbol

/** Coalesces equal keyed work and forgets it as soon as it settles. */
export class SingleFlightByKey<TKey, TIdentity> {
  private readonly inFlight = new Map<TKey, { identity: TIdentity; promise: Promise<void> }>()

  run(key: TKey, identity: TIdentity, task: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(key)
    if (existing?.identity === identity) {
      return existing.promise
    }

    const promise = task().finally(() => {
      if (this.inFlight.get(key)?.promise === promise) {
        this.inFlight.delete(key)
      }
    })
    this.inFlight.set(key, { identity, promise })
    return promise
  }

  clear(): void {
    this.inFlight.clear()
  }

  invalidate(key: TKey): boolean {
    return this.inFlight.delete(key)
  }

  get activeCount(): number {
    return this.inFlight.size
  }
}

/**
 * Tracks only the newest in-flight request for each key. Tokens are unique, so
 * deleting a completed token can never let an older request match a later one.
 */
export class LatestRequestByKey<TKey> {
  private readonly current = new Map<TKey, LatestRequestToken>()

  begin(key: TKey): LatestRequestToken {
    const token = Symbol('latest-request')
    this.current.set(key, token)
    return token
  }

  isCurrent(key: TKey, token: LatestRequestToken): boolean {
    return this.current.get(key) === token
  }

  isActive(key: TKey): boolean {
    return this.current.has(key)
  }

  finish(key: TKey, token: LatestRequestToken): boolean {
    if (!this.isCurrent(key, token)) {
      return false
    }
    this.current.delete(key)
    return true
  }

  invalidate(key: TKey): boolean {
    return this.current.delete(key)
  }

  clear(): void {
    this.current.clear()
  }

  get activeCount(): number {
    return this.current.size
  }
}

/**
 * Coalesces refreshes within one client generation while allowing a new
 * generation to start immediately. Callers must check `isCurrent` before
 * committing results so a slow response from an old backend cannot win.
 */
export class SingleFlightGeneration {
  private generation = 0
  private inFlight: { generation: number; promise: Promise<void> } | null = null

  invalidate(): void {
    this.generation += 1
    this.inFlight = null
  }

  run(task: (isCurrent: GenerationIsCurrent) => Promise<void>): Promise<void> {
    const generation = this.generation
    if (this.inFlight?.generation === generation) {
      return this.inFlight.promise
    }

    const promise = task(() => this.generation === generation).finally(() => {
      if (this.inFlight?.generation === generation && this.inFlight.promise === promise) {
        this.inFlight = null
      }
    })
    this.inFlight = { generation, promise }
    return promise
  }
}
