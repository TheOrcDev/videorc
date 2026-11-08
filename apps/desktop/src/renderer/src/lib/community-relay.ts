import type { BackendClient } from '@/backendClient'
import type { VideorcApi } from '@/lib/backend'
import { isCommunityRelayMethod } from '../../../shared/community-relay'

// The person card's calls from the Stream Manager (plan 225 C2), Studio's
// half. Loaded with the chat moderation relay, out of the main window's
// eager bundle. The window names an allowlisted `cohost.community.*` method;
// this makes the call on the Studio's socket (the typed client validates the
// params and the result against the strict contract) and answers with the
// result or the backend's own sentence ("X viewers link themselves with
// !link.").

type CommunityClient = Pick<BackendClient, 'request'>
type RelayApi = Partial<Pick<VideorcApi, 'onCommunityRequest' | 'pushCommunityResult'>>

export interface CommunityRelayOptions {
  client: CommunityClient
  api?: RelayApi
}

export function startCommunityRelay(options: CommunityRelayOptions): () => void {
  const api: RelayApi = options.api ?? globalThis.window?.videorc ?? {}
  const off = api.onCommunityRequest?.((command) => {
    if (!isCommunityRelayMethod(command.method)) {
      void api
        .pushCommunityResult?.({
          requestId: command.requestId,
          ok: false,
          error: 'That is not a community call.'
        })
        .catch(() => undefined)
      return
    }
    void options.client
      .request(command.method, command.params)
      .then((value) =>
        api.pushCommunityResult?.({ requestId: command.requestId, ok: true, value: value ?? null })
      )
      .catch((error: unknown) =>
        api.pushCommunityResult?.({
          requestId: command.requestId,
          ok: false,
          error:
            error instanceof Error && error.message.trim()
              ? error.message
              : "Couldn't reach your community."
        })
      )
      .catch(() => undefined)
  })
  return () => off?.()
}
