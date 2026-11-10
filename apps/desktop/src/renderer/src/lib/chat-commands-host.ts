// Plan 226: chat commands' work in the main window, whatever page is in
// front. The Studio provider loads this chunk when its backend connection
// comes up and hands the connection over; the store reads the list on it and
// follows its events.

import type { ChatCommandsClient, ChatCommandsStore } from './chat-commands-store'
import { chatCommandsStore } from './chat-commands-store'

/** A backend connection came up: chat commands read and follow it. */
export function attachChatCommands(
  client: ChatCommandsClient,
  store: ChatCommandsStore = chatCommandsStore
): void {
  store.connect(client)
}
