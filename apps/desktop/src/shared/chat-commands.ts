// Plan 226: chat commands. A viewer types `!go` in chat and Videorc answers
// as the streamer with the reply they saved, starting with the viewer's
// @name, in the chat the viewer asked in. `!commands` (built in) lists them.
//
// This module is the TypeScript half of the contract: the wire types, the
// limits and the editor's validation. The Rust half (`chat_commands.rs`)
// holds the same rules; `protocol-fixtures/chat-commands.json` pins the cases
// both languages must agree on. Pure and schema-free: the runtime schemas live
// in `backend-rpc-contract.ts`.

import type { CommentsCommandResolution, StreamPlatform } from './backend'

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

// --- The editor's helpers (plan 226 S3) ---

/** The mention the editor's X note counts with: a typical `@name `. */
export const CHAT_COMMAND_TYPICAL_MENTION = '@viewer_name '

/** How many characters the reply has left; negative when it is over. */
export function chatCommandReplyRoom(reply: string): number {
  return CHAT_COMMAND_REPLY_MAX_CHARS - chatCommandTextLength(reply.trim())
}

/** True when `@viewer_name <reply>` won't fit one X post, so X gets it in 2. */
export function chatCommandNeedsTwoXPosts(reply: string): boolean {
  return (
    chatCommandTextLength(CHAT_COMMAND_TYPICAL_MENTION + reply.trim()) >
    CHAT_COMMAND_X_POST_MAX_CHARS
  )
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every sentence the rules above say, as the field it belongs to. */
const REFUSALS: readonly (readonly [keyof ChatCommandDraftErrors, RegExp])[] = [
  ['name', /Name the command\./],
  ['name', new RegExp(`Keep the name to ${CHAT_COMMAND_NAME_MAX_CHARS} characters\\.`)],
  ['name', /Use letters, numbers, _ and - only\./],
  ['name', new RegExp(`!${escaped(CHAT_COMMANDS_LIST_NAME)} is built in\\.`)],
  ['name', /![a-z0-9_-]+ already exists\./],
  ['description', /Add a short description\./],
  ['description', /Keep the description on one line\./],
  [
    'description',
    new RegExp(`Keep the description to ${CHAT_COMMAND_DESCRIPTION_MAX_CHARS} characters\\.`)
  ],
  ['reply', /Write the reply\./],
  ['reply', /Keep the reply on one line\./],
  ['reply', new RegExp(`Keep the reply to ${CHAT_COMMAND_REPLY_MAX_CHARS} characters\\.`)]
]

/**
 * A `chatCommands.save` refusal the backend wrote in the editor's own words
 * ("!go already exists."), with the field it is about, so the dialog shows it
 * under that field. Null for any other failure.
 */
export function chatCommandRefusal(
  raw: string
): { field: keyof ChatCommandDraftErrors; sentence: string } | null {
  for (const [field, pattern] of REFUSALS) {
    const match = pattern.exec(raw)
    if (match) return { field, sentence: match[0] }
  }
  return null
}

// --- The Stream Manager (plan 226 S4) ---

/** The most reply failures the Stream Manager carries for one live chat session. */
export const CHAT_COMMAND_FAILURES_MAX = 20

/** Stream Manager → main → Studio: the streamer's `!go`, with main's request id. */
export interface ChatCommandRelayCommand {
  requestId: string
  sessionId: string
  /** Without the `!`, lowercase. `commands` is the built-in list. */
  name: string
}

/** The ⋯ menu's Chat commands…: nothing but its request id. */
export interface OpenChatCommandsCommand {
  requestId: string
}

// The preload API's chat command methods (plan 226 S4), joined to
// `VideorcApi` by module augmentation like the soundboard's; every program
// that types `VideorcApi` also compiles this file (both tsconfigs include
// `src/shared`).
declare module './backend' {
  interface VideorcApi {
    /** The enabled commands Studio pushes (null until it reads them); the
     * Stream Manager seeds from main's copy and follows. */
    getCommentsChatCommands: () => Promise<ChatCommandsSummary | null>
    pushCommentsChatCommands: (summary: ChatCommandsSummary | null) => Promise<boolean>
    onCommentsChatCommands: (callback: (summary: ChatCommandsSummary | null) => void) => () => void
    /** The streamer's `!go` in the composer: relayed to the MAIN renderer,
     * which owns the backend socket and makes the `chatCommands.post` call. */
    chatCommandFromCommentsWindow: (
      command: ChatCommandRelayCommand
    ) => Promise<ChatCommandPostResult>
    onChatCommandRequest: (callback: (command: ChatCommandRelayCommand) => void) => () => void
    pushChatCommandResult: (
      resolution: CommentsCommandResolution<ChatCommandPostResult>
    ) => Promise<boolean>
    /** The replies that couldn't go out in the newest live chat session, one
     * per chat and reason; Studio pushes, the Stream Manager shows them. */
    getChatCommandFailures: () => Promise<ChatCommandReplyFailed[]>
    pushChatCommandFailures: (failures: ChatCommandReplyFailed[]) => Promise<boolean>
    onChatCommandFailures: (callback: (failures: ChatCommandReplyFailed[]) => void) => () => void
    /** ⋯ Chat commands…: main shows the main window, which opens Livestream →
     * Setup and scrolls to the section. */
    openChatCommandsFromCommentsWindow: (command: OpenChatCommandsCommand) => Promise<boolean>
    onOpenChatCommands: (callback: () => void) => () => void
  }
}

/** Whether the Stream Manager knows `name` (lowercase) as a command it can post. */
export function chatCommandAvailable(
  name: string,
  summary: ChatCommandsSummary | null | undefined
): boolean {
  if (!summary) return false
  if (name === CHAT_COMMANDS_LIST_NAME) return summary.listEnabled && summary.commands.length > 0
  return summary.commands.some((command) => command.name === name)
}

/**
 * The streamer's own `!` draft in the Stream Manager (plan 226 D9): exactly
 * `!name` (any case) for a command it knows posts that command's reply to
 * every chat; `!!name` for one sends the literal `!name`; anything else
 * (an unknown name, `!go and more words`) is ordinary chat, as typed.
 */
export function classifyChatCommandDraft(
  text: string,
  summary: ChatCommandsSummary | null | undefined
): { kind: 'chatCommand'; name: string } | { kind: 'chat'; text: string } {
  const literal = /^!!([^\s!]+)$/.exec(text)
  if (literal && chatCommandAvailable(literal[1].toLowerCase(), summary)) {
    return { kind: 'chat', text: text.slice(1) }
  }
  const command = /^!([^\s!]+)$/.exec(text)
  if (command && chatCommandAvailable(command[1].toLowerCase(), summary)) {
    return { kind: 'chatCommand', name: command[1].toLowerCase() }
  }
  return { kind: 'chat', text }
}

/** One row of the composer's completion list: the text and what it does. */
export interface ChatCommandCompletion {
  value: string
  hint: string
}

/**
 * The completions after `!`: each command whose name starts with what was
 * typed (`!go · why I'm learning Go`), then `!commands` while it answers.
 * Null when the draft isn't a `!` name being typed.
 */
export function chatCommandCompletions(
  draft: string,
  summary: ChatCommandsSummary | null | undefined
): ChatCommandCompletion[] | null {
  const typing = /^!([^\s!]*)$/.exec(draft.trimStart())
  if (!typing || !summary) return null
  const typed = typing[1].toLowerCase()
  const completions = summary.commands
    .filter((command) => command.name.startsWith(typed))
    .map((command) => ({ value: `!${command.name}`, hint: ` · ${command.description}` }))
  if (chatCommandAvailable(CHAT_COMMANDS_LIST_NAME, summary)) {
    if (CHAT_COMMANDS_LIST_NAME.startsWith(typed)) {
      completions.push({ value: `!${CHAT_COMMANDS_LIST_NAME}`, hint: ' · List your commands' })
    }
  }
  return completions
}

const chats = (count: number): string => `${count} ${count === 1 ? 'chat' : 'chats'}`

/** The composer's line after the streamer's `!go` (plan 226 D9). */
export function chatCommandPostNotice(name: string, result: ChatCommandPostResult): string {
  const reply = `the !${name} reply`
  if (result.sent === 0) {
    return result.failed > 0
      ? `Couldn't post ${reply}. No chat could take it.`
      : `Couldn't post ${reply}. No chat can take posts right now.`
  }
  if (result.failed === 0) return `Posted ${reply}.`
  return `Posted ${reply} to ${chats(result.sent)}. ${result.failed} couldn't take it.`
}

/** A reply that couldn't go out, in the Stream Manager's words (plan 226 D12). */
export function chatCommandReplyFailedLine(
  failure: Pick<ChatCommandReplyFailed, 'command' | 'reason'>,
  platformName: string
): string {
  return `!${failure.command} couldn't answer on ${platformName}: ${failure.reason}`
}
