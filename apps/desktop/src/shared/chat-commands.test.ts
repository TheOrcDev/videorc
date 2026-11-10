import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  CHAT_COMMAND_DESCRIPTION_MAX_CHARS,
  CHAT_COMMAND_MAX_COUNT,
  CHAT_COMMAND_NAME_MAX_CHARS,
  CHAT_COMMAND_REPLY_MAX_CHARS,
  CHAT_COMMAND_X_POST_MAX_CHARS,
  CHAT_COMMANDS_LIST_NAME,
  chatCommandDescriptionError,
  chatCommandNameError,
  chatCommandOneLine,
  chatCommandReplyError,
  chatCommandsSummary,
  chatCommandTextLength,
  normalizeChatCommandName,
  validateChatCommandDraft,
  type ChatCommand
} from './chat-commands'

// Plan 226: the cases `chat_commands.rs` checks too. Both languages read the
// same file, so the editor never accepts what the backend refuses.
interface ChatCommandCases {
  limits: {
    nameMaxChars: number
    descriptionMaxChars: number
    replyMaxChars: number
    maxCount: number
    xPostMaxChars: number
    listName: string
  }
  names: {
    input: string
    normalized: string
    error: string | null
    id?: string
    existing?: { id: string; name: string }[]
  }[]
  descriptions: { input: string; error: string | null }[]
  replies: { input: string; error: string | null }[]
}

const cases = JSON.parse(
  readFileSync(new URL('../../../../protocol-fixtures/chat-commands.json', import.meta.url), 'utf8')
) as ChatCommandCases

function command(name: string, enabled = true): ChatCommand {
  return {
    id: `id-${name}`,
    name,
    description: `about ${name}`,
    reply: `reply for ${name}`,
    enabled,
    createdAt: '2026-11-10T18:00:00Z',
    updatedAt: '2026-11-10T18:00:00Z'
  }
}

describe('chat command rules (plan 226)', () => {
  it('uses the limits the backend uses', () => {
    expect(cases.limits).toMatchObject({
      nameMaxChars: CHAT_COMMAND_NAME_MAX_CHARS,
      descriptionMaxChars: CHAT_COMMAND_DESCRIPTION_MAX_CHARS,
      replyMaxChars: CHAT_COMMAND_REPLY_MAX_CHARS,
      maxCount: CHAT_COMMAND_MAX_COUNT,
      xPostMaxChars: CHAT_COMMAND_X_POST_MAX_CHARS,
      listName: CHAT_COMMANDS_LIST_NAME
    })
  })

  it.each(cases.names)('names: $input', ({ input, normalized, error, id, existing }) => {
    expect(normalizeChatCommandName(input)).toBe(normalized)
    expect(chatCommandNameError(input, existing ?? [], id) ?? null).toBe(error)
  })

  it.each(cases.descriptions)('descriptions: case %#', ({ input, error }) => {
    expect(chatCommandDescriptionError(input) ?? null).toBe(error)
  })

  it.each(cases.replies)('replies: case %#', ({ input, error }) => {
    expect(chatCommandReplyError(input) ?? null).toBe(error)
  })

  it('counts code points, not UTF-16 units', () => {
    expect(chatCommandTextLength('🚀🚀')).toBe(2)
    expect(chatCommandReplyError('🚀'.repeat(CHAT_COMMAND_REPLY_MAX_CHARS))).toBeUndefined()
  })

  it('turns pasted line breaks into spaces', () => {
    expect(chatCommandOneLine('one\ntwo\r\nthree\rfour')).toBe('one two three four')
    expect(chatCommandReplyError(chatCommandOneLine('one\ntwo'))).toBeUndefined()
  })

  it('collects every field error, or null when the draft can be saved', () => {
    expect(validateChatCommandDraft({ name: '', description: '', reply: '' })).toEqual({
      name: 'Name the command.',
      description: 'Add a short description.',
      reply: 'Write the reply.'
    })
    expect(
      validateChatCommandDraft({ name: '!go', description: 'why Go', reply: 'Because.' }, [
        command('faq')
      ])
    ).toBeNull()
  })

  it('pushes only enabled commands, name and description, to the Stream Manager', () => {
    const summary = chatCommandsSummary({
      commands: [command('faq', false), command('go')],
      listEnabled: true
    })
    expect(summary).toStrictEqual({
      commands: [{ name: 'go', description: 'about go' }],
      listEnabled: true
    })
  })
})
