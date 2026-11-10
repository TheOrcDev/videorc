import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'

import { ipcErrorMessage } from '@/lib/ipc-error-message'
import {
  chatCommandsStore,
  type ChatCommandsSnapshot,
  type ChatCommandsStore
} from '@/lib/chat-commands-store'
import { inlineUserError, OFFLINE_REASON } from '@/lib/user-error'
import {
  chatCommandRefusal,
  type ChatCommand,
  type ChatCommandDraftErrors,
  type ChatCommandSaveParams
} from '../../../shared/chat-commands'

/** Why a save didn't happen: under a field when it is about one, else for the dialog. */
export interface ChatCommandSaveRefusal {
  field?: keyof ChatCommandDraftErrors
  message: string
}

export interface ChatCommandsView extends ChatCommandsSnapshot {
  /** A switch or a delete that didn't happen, for the section's own line. */
  error: string | null
  /** Resolves to null when saved, or to why not. */
  save: (params: ChatCommandSaveParams) => Promise<ChatCommandSaveRefusal | null>
  /** Resolves true when deleted. */
  remove: (command: ChatCommand) => Promise<boolean>
  setEnabled: (command: ChatCommand, enabled: boolean) => Promise<void>
  setListEnabled: (enabled: boolean) => Promise<void>
  /** Reads the list again after a failed read. */
  reload: () => void
  /** The Stream Manager's door has scrolled here. */
  revealHandled: () => void
}

/**
 * Livestream → Setup → Chat commands (plan 226 S3): the list and the
 * `!commands` switch from Studio's backend connection, kept current by
 * `chatCommands.changed`, and the mutations, each answered with the whole
 * state. A refusal the backend wrote in the editor's words goes under its
 * field; anything else is the usual "Couldn't …" line.
 */
export function useChatCommands(store: ChatCommandsStore = chatCommandsStore): ChatCommandsView {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(
    async (params: ChatCommandSaveParams): Promise<ChatCommandSaveRefusal | null> => {
      const client = store.client()
      if (!client) return { message: OFFLINE_REASON }
      try {
        store.acceptState(await client.requestTyped('chatCommands.save', params))
        return null
      } catch (caught) {
        const refusal = chatCommandRefusal(ipcErrorMessage(caught))
        return refusal
          ? { field: refusal.field, message: refusal.sentence }
          : {
              message: inlineUserError(
                caught,
                { action: 'save', object: 'the command' },
                'chat-commands'
              )
            }
      }
    },
    [store]
  )

  const remove = useCallback(
    async (command: ChatCommand): Promise<boolean> => {
      const client = store.client()
      if (!client) {
        setError(OFFLINE_REASON)
        return false
      }
      try {
        store.acceptState(await client.requestTyped('chatCommands.delete', { id: command.id }))
        setError(null)
        return true
      } catch (caught) {
        setError(
          inlineUserError(caught, { action: 'delete', object: `!${command.name}` }, 'chat-commands')
        )
        return false
      }
    },
    [store]
  )

  const setEnabled = useCallback(
    async (command: ChatCommand, enabled: boolean): Promise<void> => {
      const refusal = await save({
        id: command.id,
        name: command.name,
        description: command.description,
        reply: command.reply,
        enabled
      })
      setError(refusal ? refusal.message : null)
    },
    [save]
  )

  const setListEnabled = useCallback(
    async (enabled: boolean): Promise<void> => {
      const client = store.client()
      if (!client) {
        setError(OFFLINE_REASON)
        return
      }
      try {
        store.acceptState(await client.requestTyped('chatCommands.setListEnabled', { enabled }))
        setError(null)
      } catch (caught) {
        setError(
          inlineUserError(
            caught,
            { action: enabled ? 'turn on' : 'turn off', object: '!commands' },
            'chat-commands'
          )
        )
      }
    },
    [store]
  )

  return useMemo(
    () => ({
      ...snapshot,
      error,
      save,
      remove,
      setEnabled,
      setListEnabled,
      reload: store.reload,
      revealHandled: store.revealHandled
    }),
    [error, remove, save, setEnabled, setListEnabled, snapshot, store]
  )
}
