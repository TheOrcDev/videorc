// Remote-control intents (Stream Deck, the phone) arrive as backend events and
// run one at a time, in arrival order: each executor samples session truth
// only when its turn begins, and a failed predecessor cannot poison the tail.
//
// Sound intents (plan 189) get a lane of their own (release test 147, plan
// 0003). A press is about the moment it was made: behind a scene switch that
// took 15 s to fail, a Stream Deck airhorn played 12 s late, near the end of
// the take. Sound presses keep their order among themselves (a stop never
// overtakes its play) but never wait behind another kind of intent, and one
// that still waited too long is refused rather than played at the wrong time.
// Pure apart from the injected runner and clock, so the rules are tested in node.

/** A sound press older than this when its turn comes is refused, not played. */
export const REMOTE_SOUND_INTENT_STALE_MS = 1_000

/** What a deck or phone shows for a sound press that waited too long. */
export const REMOTE_SOUND_STALE_MESSAGE = "That sound was pressed too long ago, so it didn't play."

const SOUND_INTENT_KINDS = new Set(['soundPlay', 'soundStop'])

/** The relayed `remote.intent` event: `{intentId, intent: {kind, …}}`. */
export function remoteIntentKind(payload: unknown): string | undefined {
  const intent = (payload as { intent?: { kind?: unknown } } | null)?.intent
  return typeof intent?.kind === 'string' ? intent.kind : undefined
}

export function isSoundIntent(payload: unknown): boolean {
  return SOUND_INTENT_KINDS.has(remoteIntentKind(payload) ?? '')
}

export interface RemoteIntentQueueOptions {
  /** Runs one intent to its ack. */
  run: (payload: unknown) => Promise<void>
  /** Acks a sound press that waited past the stale budget, without running it. */
  refuseStale: (payload: unknown) => Promise<void>
  now?: () => number
  staleMs?: number
}

export interface RemoteIntentQueue {
  /** Queues the intent on its lane; resolves when it has run (or was refused). */
  enqueue: (payload: unknown) => Promise<void>
}

export function createRemoteIntentQueue({
  run,
  refuseStale,
  now = () => Date.now(),
  staleMs = REMOTE_SOUND_INTENT_STALE_MS
}: RemoteIntentQueueOptions): RemoteIntentQueue {
  let tail: Promise<void> = Promise.resolve()
  let soundTail: Promise<void> = Promise.resolve()
  return {
    enqueue(payload) {
      const sound = isSoundIntent(payload)
      const queuedAt = now()
      const turn = (sound ? soundTail : tail)
        .catch(() => undefined)
        .then(() => (sound && now() - queuedAt > staleMs ? refuseStale(payload) : run(payload)))
      const settled = turn.then(
        () => undefined,
        () => undefined
      )
      if (sound) soundTail = settled
      else tail = settled
      return turn
    }
  }
}
