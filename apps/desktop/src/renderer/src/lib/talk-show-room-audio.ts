// Remote audio in the host's room (plan 224 D7, D11): every subscribed
// voice plays through a hidden element in the audio host, except the
// runner's return. The return is the program, the host's own voice included:
// playing it would be an echo for the host and the room (the review of
// 2026-11-09, H1). The Program monitor gets the return's audio through the
// snapshot and decides on its own whether and how to play it. Pure of
// `livekit-client`, so the rule is a unit test.

/** The runner's identity prefix: its tracks are the return (R-G5). */
export const RUNNER_IDENTITY_PREFIX = 'runner:'

export function isRunnerIdentity(identity: string): boolean {
  return identity.startsWith(RUNNER_IDENTITY_PREFIX)
}

/**
 * LiveKit's recorder (plan 234: the program page of a managed show joins
 * the room as `EG_…`). It publishes nothing and is nobody: never listed,
 * never counted, never sent the guests' stage message.
 */
export const RECORDER_IDENTITY_PREFIX = 'EG_'

export function isRecorderIdentity(identity: string): boolean {
  return identity.startsWith(RECORDER_IDENTITY_PREFIX)
}

/** What the attach path needs of a remote audio track. */
export interface AttachableAudioTrack<Element> {
  attach(): Element
  detach(): Element[]
}

export interface AudioElementLike {
  setAttribute(name: string, value: string): void
  remove(): void
}

export interface AudioHostLike<Element> {
  appendChild(element: Element): unknown
}

/** Whether a subscribed audio track from `identity` plays through the audio host. */
export function playsRemoteAudio(identity: string): boolean {
  return !isRunnerIdentity(identity)
}

/**
 * The hidden audio elements per identity. `subscribed` attaches a voice and
 * skips the runner; `unsubscribed` detaches that track's elements; `clear`
 * removes everything on leave.
 */
export class RemoteAudioAttachments<Element extends AudioElementLike> {
  readonly #host: () => AudioHostLike<Element> | null
  readonly #attached = new Map<string, Element[]>()

  constructor(host: () => AudioHostLike<Element> | null) {
    this.#host = host
  }

  /** The element a subscription attached, or null when none was (the runner, no host). */
  subscribed(identity: string, track: AttachableAudioTrack<Element>): Element | null {
    if (!playsRemoteAudio(identity)) return null
    const host = this.#host()
    if (!host) return null
    const element = track.attach()
    element.setAttribute('data-talk-show-audio', identity)
    host.appendChild(element)
    const list = this.#attached.get(identity) ?? []
    list.push(element)
    this.#attached.set(identity, list)
    return element
  }

  unsubscribed(identity: string, track: AttachableAudioTrack<Element>): void {
    const detached = track.detach()
    for (const element of detached) element.remove()
    const list = (this.#attached.get(identity) ?? []).filter(
      (element) => !detached.includes(element)
    )
    if (list.length) this.#attached.set(identity, list)
    else this.#attached.delete(identity)
  }

  clear(): void {
    for (const elements of this.#attached.values()) {
      for (const element of elements) {
        element.remove()
      }
    }
    this.#attached.clear()
  }

  /** The identities with an element playing, for the tests. */
  identities(): string[] {
    return [...this.#attached.keys()]
  }
}
