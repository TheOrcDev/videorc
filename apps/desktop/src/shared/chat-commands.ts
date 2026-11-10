// Plan 226: chat commands. A viewer types `!go` in chat and Videorc answers
// as the streamer with the reply they saved, starting with the viewer's
// @name, in the chat the viewer asked in. `!commands` (built in) lists them.
//
// This module is the TypeScript half of the contract: the wire types, the
// limits and the editor's validation. The Rust half (`chat_commands.rs`)
// holds the same rules; `protocol-fixtures/chat-commands.json` pins the cases
// both languages must agree on. Pure and schema-free: the runtime schemas live
// in `backend-rpc-contract.ts`.

import type { StreamPlatform } from './backend'

/** One saved command, as the backend stores and sends it. */
export interface ChatCommand {
  /** Opaque UUID. */
  id: string
  /** Lowercase, without the `!`: `go`. */
  name: string
  /** One line, shown by `!commands`: "why I'm learning Go". */
  description: string
  /** One line, sent as `@viewer <reply>`. */
  reply: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** `chatCommands.list`, every mutation's result and `chatCommands.changed`. */
export interface ChatCommandsState {
  /** A–Z by name. */
  commands: ChatCommand[]
  /** Whether the built-in `!commands` answers. */
  listEnabled: boolean
}

/**
 * `chatCommands.save`: no `id` creates, an `id` replaces that command. The
 * backend normalizes the name (trim, one leading `!`, lowercase) and refuses
 * anything `validateChatCommandDraft` refuses, with the same words.
 */
export interface ChatCommandSaveParams {
  id?: string
  name: string
  description: string
  reply: string
  enabled: boolean
}

export interface ChatCommandIdParams {
  id: string
}

export interface ChatCommandsListEnabledParams {
  enabled: boolean
}

/**
 * `chatCommands.post`: the streamer typed `!go` (or `!commands`) in the
 * Stream Manager. The backend posts the reply, without a mention, to every
 * chat that can take posts in this live chat session (plan 226 D9).
 */
export interface ChatCommandPostParams {
  sessionId: string
  /** Without the `!`, any case. `commands` is the built-in list. */
  name: string
}

/** How many chats took the post and how many refused it (each refusal also
 * arrives as `chatCommands.replyFailed`). */
export interface ChatCommandPostResult {
  sent: number
  failed: number
}

/**
 * `chatCommands.replyFailed`: a reply that couldn't go out (plan 226 D12).
 * Sent once per destination and reason per live chat session.
 */
export interface ChatCommandReplyFailed {
  sessionId: string
  destinationId: string
  platform: StreamPlatform
  /** Without the `!`. */
  command: string
  /** The words the Stream Manager shows after "!go couldn't answer on YouTube: ". */
  reason: string
}

/** What the Stream Manager carries (pushed by the Studio renderer): enabled
 * commands only, A–Z, and never anything the window doesn't use. */
export interface ChatCommandSummary {
  name: string
  description: string
}

export interface ChatCommandsSummary {
  commands: ChatCommandSummary[]
  listEnabled: boolean
}

/** The built-in command's name. Nobody can save a command with it. */
export const CHAT_COMMANDS_LIST_NAME = 'commands'
export const CHAT_COMMAND_NAME_MAX_CHARS = 24
export const CHAT_COMMAND_DESCRIPTION_MAX_CHARS = 60
/** 200 (Videorc's chat send) minus room for `@name ` (plan 226 D2). */
export const CHAT_COMMAND_REPLY_MAX_CHARS = 170
export const CHAT_COMMAND_MAX_COUNT = 100
/** X takes 140 characters a post; a longer reply goes out in 2 posts there. */
export const CHAT_COMMAND_X_POST_MAX_CHARS = 140

const NAME_PATTERN = /^[a-z0-9_-]+$/
// Any C0/C1 control character, line breaks included.
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

/** Length the way both languages count it: Unicode code points. */
export function chatCommandTextLength(text: string): number {
  return [...text].length
}

/** `!Go ` → `go`. Only one leading `!` is dropped. */
export function normalizeChatCommandName(raw: string): string {
  const trimmed = raw.trim()
  return (trimmed.startsWith('!') ? trimmed.slice(1) : trimmed).trim().toLowerCase()
}

/** A pasted line break becomes a space, the way the editor shows it. */
export function chatCommandOneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
}

export interface ChatCommandDraft {
  /** The command being edited; absent when adding. */
  id?: string
  name: string
  description: string
  reply: string
}

export interface ChatCommandDraftErrors {
  name?: string
  description?: string
  reply?: string
}

/** The name problem, in the words the editor and the backend both use. */
export function chatCommandNameError(
  rawName: string,
  existing: readonly Pick<ChatCommand, 'id' | 'name'>[] = [],
  id?: string
): string | undefined {
  const name = normalizeChatCommandName(rawName)
  if (!name) return 'Name the command.'
  if (chatCommandTextLength(name) > CHAT_COMMAND_NAME_MAX_CHARS) {
    return `Keep the name to ${CHAT_COMMAND_NAME_MAX_CHARS} characters.`
  }
  if (!NAME_PATTERN.test(name)) return 'Use letters, numbers, _ and - only.'
  if (name === CHAT_COMMANDS_LIST_NAME) return `!${CHAT_COMMANDS_LIST_NAME} is built in.`
  if (existing.some((command) => command.name === name && command.id !== id)) {
    return `!${name} already exists.`
  }
  return undefined
}

export function chatCommandDescriptionError(raw: string): string | undefined {
  const description = raw.trim()
  if (!description) return 'Add a short description.'
  if (CONTROL_PATTERN.test(description)) return 'Keep the description on one line.'
  if (chatCommandTextLength(description) > CHAT_COMMAND_DESCRIPTION_MAX_CHARS) {
    return `Keep the description to ${CHAT_COMMAND_DESCRIPTION_MAX_CHARS} characters.`
  }
  return undefined
}

export function chatCommandReplyError(raw: string): string | undefined {
  const reply = raw.trim()
  if (!reply) return 'Write the reply.'
  if (CONTROL_PATTERN.test(reply)) return 'Keep the reply on one line.'
  if (chatCommandTextLength(reply) > CHAT_COMMAND_REPLY_MAX_CHARS) {
    return `Keep the reply to ${CHAT_COMMAND_REPLY_MAX_CHARS} characters.`
  }
  return undefined
}

/** Null when the draft can be saved. */
export function validateChatCommandDraft(
  draft: ChatCommandDraft,
  existing: readonly Pick<ChatCommand, 'id' | 'name'>[] = []
): ChatCommandDraftErrors | null {
  const errors: ChatCommandDraftErrors = {}
  const name = chatCommandNameError(draft.name, existing, draft.id)
  const description = chatCommandDescriptionError(draft.description)
  const reply = chatCommandReplyError(draft.reply)
  if (name) errors.name = name
  if (description) errors.description = description
  if (reply) errors.reply = reply
  return name || description || reply ? errors : null
}

/** The projection the Studio renderer pushes to the Stream Manager. */
export function chatCommandsSummary(state: ChatCommandsState): ChatCommandsSummary {
  return {
    commands: state.commands
      .filter((command) => command.enabled)
      .map(({ name, description }) => ({ name, description })),
    listEnabled: state.listEnabled
  }
}
