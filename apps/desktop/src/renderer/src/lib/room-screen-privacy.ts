import type { ScreenPrivacy } from '@/lib/backend'

/** Eager, SDK-free bridge. Unknown backend state is closed, never permission to publish. */
export class ScreenPrivacyDecision {
  hidden = true
  revision = 0
  #generation = -1
  #pending = 0
  #listeners = new Set<() => void>()
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  #notify(): void {
    for (const listener of this.#listeners) listener()
  }
  hide(): number {
    this.#pending = ++this.revision
    this.hidden = true
    this.#notify()
    return this.revision
  }
  showIntent(): number {
    return this.revision
  }
  apply(value: ScreenPrivacy, intent?: number, explicitShow = false): void {
    const generation = value.generation
    // Old backends may hide, but cannot authorize browser Show.
    const validShow = explicitShow && intent === this.revision
    if (generation === undefined) {
      if (value.hidden) {
        this.hidden = true
        this.#notify()
      }
      return
    }
    if (generation < this.#generation && !validShow) return
    if (generation === this.#generation && this.hidden && !value.hidden && !validShow) return
    if (intent !== undefined && (intent === this.#pending || validShow)) this.#pending = 0
    if (!value.hidden && this.#pending !== 0) return
    if (generation === this.#generation && value.hidden === this.hidden) return
    this.#generation = generation
    this.hidden = value.hidden
    ++this.revision
    this.#notify()
  }
}
export const roomScreenPrivacy = new ScreenPrivacyDecision()

export type ScreenPrivacyPublication = {
  epoch: string
  generation: number
  hidden: boolean
}
export const PRIVACY_ACK_TOPIC = 'videorc.screen-privacy.ack.v1'
export const PRIVACY_TOPIC = 'videorc.screen-privacy.v1'
export function privacyTrackName(value: ScreenPrivacyPublication): string {
  return `vrc-privacy:${value.epoch}:${value.generation}:${value.hidden ? 1 : 0}`
}
export function privacyObservationMatches(
  value: unknown,
  expected: ScreenPrivacyPublication
): value is ScreenPrivacyPublication & {
  receiver: string
  receiverSession?: string
  appliedAt: number
} {
  if (!value || typeof value !== 'object') return false
  const one = value as Record<string, unknown>
  return (
    one.epoch === expected.epoch &&
    one.generation === expected.generation &&
    one.hidden === true &&
    typeof one.receiver === 'string' &&
    Number.isSafeInteger(one.appliedAt) &&
    Number(one.appliedAt) > 0
  )
}
