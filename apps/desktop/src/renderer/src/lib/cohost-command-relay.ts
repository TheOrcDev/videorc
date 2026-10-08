import type { BackendClient } from '@/backendClient'
import type { CohostCommandRelayCommand, CohostState, VideorcApi } from '@/lib/backend'

// Answers to Golem's voice command cards from the Stream Manager (plan 140,
// S6 part B), Studio's half. Loaded with the chat moderation relay, out of
// the main window's eager bundle. The window names the command and the
// answer; this makes the `cohost.command.*` call and replies with the state.
// The state goes through Studio's own merge first, so a reply that crossed a
// newer `cohost.state` event never rolls the command back.

type CommandClient = Pick<BackendClient, 'requestTyped'>
type RelayApi = Partial<Pick<VideorcApi, 'onCohostCommandRequest' | 'pushCohostCommandResult'>>

export interface CohostCommandRelayOptions {
  client: CommandClient
  /** Studio's live chat session; a command for another one is refused. */
  sessionId: () => string | null | undefined
  /** Studio's `commitCohostState` (newest command wins). */
  commit: (state: CohostState) => void
  api?: RelayApi
}

export function runCohostCommand(
  client: CommandClient,
  command: CohostCommandRelayCommand
): Promise<CohostState> {
  switch (command.action) {
    case 'choose':
      return client.requestTyped('cohost.command.choose', {
        commandId: command.commandId,
        index: command.index
      })
    case 'confirm':
      return client.requestTyped('cohost.command.confirm', { commandId: command.commandId })
    case 'cancel':
      return client.requestTyped('cohost.command.cancel', { commandId: command.commandId })
  }
}

export function startCohostCommandRelay(options: CohostCommandRelayOptions): () => void {
  const api: RelayApi = options.api ?? globalThis.window?.videorc ?? {}
  const off = api.onCohostCommandRequest?.((command) => {
    void (async () => {
      if (command.sessionId !== options.sessionId()) {
        throw new Error('That chat view is no longer the active livestream.')
      }
      const state = await runCohostCommand(options.client, command)
      options.commit(state)
      return state
    })()
      .then((state) =>
        api.pushCohostCommandResult?.({ requestId: command.requestId, ok: true, value: state })
      )
      .catch((error: unknown) =>
        api.pushCohostCommandResult?.({
          requestId: command.requestId,
          ok: false,
          error:
            error instanceof Error && error.message.trim()
              ? error.message
              : 'Could not answer Golem.'
        })
      )
      .catch(() => undefined)
  })
  return () => off?.()
}
