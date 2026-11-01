import type { BackendClient } from '@/backendClient'
import type { VideorcApi } from '@/lib/backend'
import {
  BUDDY_ACT_RESULT_TIMEOUT_MS,
  BUDDY_NO_ANSWER,
  BUDDY_PREMIUM_REQUIRED,
  isFinalActAnswer,
  type CohostActAnswer
} from '../../../shared/buddy-act'

// `/buddy <words>` from the Stream Manager (plan 209 S20), Studio's half.
// Loaded with the chat moderation relay, out of the main window's eager
// bundle. The window sends the words; this makes the `cohost.act` call with
// the Studio's Cloud AI consent and waits for `cohost.act.result`, then
// replies with Buddy's final answer. A free user reads the voice commands'
// Premium sentence without a backend call; the backend checks Premium again.

type ActClient = Pick<BackendClient, 'requestTyped' | 'on'>
type RelayApi = Partial<Pick<VideorcApi, 'onBuddyActRequest' | 'pushBuddyActResult'>>

export interface BuddyAskOptions {
  /** The Studio's Cloud AI consent (as for `cohost.start`). */
  consent: boolean
  /** Buddy's Premium gate (`liveCohostGate`). */
  entitled: boolean
  timeoutMs?: number
  /** For tests; a fresh uuid otherwise. */
  actId?: string
}

/** One typed request, to its final answer. Never throws for a refusal: the
 * answer carries the sentence. */
export async function askBuddy(
  client: ActClient,
  sentence: string,
  options: BuddyAskOptions
): Promise<CohostActAnswer> {
  const actId = options.actId ?? `act-${crypto.randomUUID()}`
  if (!options.entitled) return { actId, status: 'unavailable', message: BUDDY_PREMIUM_REQUIRED }
  let off: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  // Listen before asking: the result can arrive before the call's reply.
  const final = new Promise<CohostActAnswer>((resolve) => {
    off = client.on('cohost.act.result', (answer) => {
      if (answer.actId === actId) resolve(answer)
    })
    timer = setTimeout(
      () => resolve({ actId, status: 'not-found', message: BUDDY_NO_ANSWER }),
      options.timeoutMs ?? BUDDY_ACT_RESULT_TIMEOUT_MS
    )
  })
  try {
    const accepted = await client.requestTyped('cohost.act', {
      actId,
      sentence,
      consentToProcessChat: options.consent
    })
    return isFinalActAnswer(accepted) ? accepted : await final
  } finally {
    off?.()
    if (timer) clearTimeout(timer)
  }
}

export interface BuddyActRelayOptions {
  client: ActClient
  consent: () => boolean
  entitled: () => boolean
  api?: RelayApi
  timeoutMs?: number
}

export function startBuddyActRelay(options: BuddyActRelayOptions): () => void {
  const api: RelayApi = options.api ?? globalThis.window?.videorc ?? {}
  const off = api.onBuddyActRequest?.((command) => {
    void askBuddy(options.client, command.sentence, {
      consent: options.consent(),
      entitled: options.entitled(),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {})
    })
      .then((answer) =>
        api.pushBuddyActResult?.({ requestId: command.requestId, ok: true, value: answer })
      )
      .catch((error: unknown) =>
        api.pushBuddyActResult?.({
          requestId: command.requestId,
          ok: false,
          error:
            error instanceof Error && error.message.trim() ? error.message : "Couldn't ask Buddy."
        })
      )
      .catch(() => undefined)
  })
  return () => off?.()
}
