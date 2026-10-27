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
//
// Agent intents (plan 209 S5) get a third lane: an agent's tool calls run in
// arrival order among themselves, never wait behind a key or a sound press,
// and never hold one back. A tool call is never refused for waiting; what its
// runner resolves is the body of the `agent.intent.ack` the caller sends.
// Pure apart from the injected runners and clock, so the rules are tested in node.

import type { AgentIntent, AgentIntentOutcome } from './studio-actions/agent'

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
  /** Runs one agent intent to its outcome (`executeAgentIntent` in lib/studio-actions). */
  runAgent?: (intent: AgentIntent) => Promise<AgentIntentOutcome>
  now?: () => number
  staleMs?: number
}

export interface RemoteIntentQueue {
  /** Queues the intent on its lane; resolves when it has run (or was refused). */
  enqueue: (payload: unknown) => Promise<void>
  /** Queues an agent's tool call on the agents' lane; resolves to what the
   * caller acks with `agent.intent.ack`. Rejects when the queue was built
   * without a `runAgent`. */
  enqueueAgent: (intent: AgentIntent) => Promise<AgentIntentOutcome>
}

export function createRemoteIntentQueue({
  run,
  refuseStale,
  runAgent,
  now = () => Date.now(),
  staleMs = REMOTE_SOUND_INTENT_STALE_MS
}: RemoteIntentQueueOptions): RemoteIntentQueue {
  let tail: Promise<void> = Promise.resolve()
  let soundTail: Promise<void> = Promise.resolve()
  let agentTail: Promise<void> = Promise.resolve()
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
    },
    enqueueAgent(intent) {
      const runner = runAgent
      if (!runner) {
        return Promise.reject(
          new Error('This queue was built without runAgent, so it cannot take agent intents.')
        )
      }
      const turn = agentTail.catch(() => undefined).then(() => runner(intent))
      agentTail = turn.then(
        () => undefined,
        () => undefined
      )
      return turn
    }
  }
}
