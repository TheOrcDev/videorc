import { describe, expect, it } from 'vitest'

import {
  POLL_COMMAND_USAGE,
  POLL_DUPLICATE_REFUSAL,
  POLL_OPTIONS_REFUSAL,
  POLL_QUESTION_REFUSAL,
  classifyPollCommand,
  pollCompletions
} from './poll-commands'
import { classifyComposerDraft } from './session-markers'

// Plan 188 S5: `/poll` opens the popover, starts a poll from one line, ends or
// cancels the running one, and never reaches a chat.

const start = (question: string, options: string[]) => ({
  kind: 'poll',
  poll: { action: 'start', question, options }
})

describe('classifyPollCommand', () => {
  it('opens the popover with nothing after /poll', () => {
    expect(classifyPollCommand('')).toEqual({ kind: 'poll', poll: { action: 'open' } })
    expect(classifyPollCommand('   ')).toEqual({ kind: 'poll', poll: { action: 'open' } })
  })

  it('splits the question at the first ? and the answers on |', () => {
    expect(classifyPollCommand('Tabs or spaces? Tabs | Spaces')).toEqual(
      start('Tabs or spaces?', ['Tabs', 'Spaces'])
    )
    // Only the first ? ends the question; the rest belongs to the answers.
    expect(classifyPollCommand('Best day? Mon? | Fri?')).toEqual(
      start('Best day?', ['Mon?', 'Fri?'])
    )
    // Spaces around the bars, and empty parts, don't count.
    expect(classifyPollCommand('  Next game?Elden Ring|  Celeste |  | Hades ')).toEqual(
      start('Next game?', ['Elden Ring', 'Celeste', 'Hades'])
    )
    expect(classifyPollCommand('Pick? 1 | 2 | 3 | 4 | 5')).toEqual(
      start('Pick?', ['1', '2', '3', '4', '5'])
    )
  })

  it('refuses 1 or 6 answers, and a line without a question mark, with the usage', () => {
    for (const query of [
      'Tabs or spaces? Tabs',
      'Tabs or spaces?',
      'Pick? a | b | c | d | e | f',
      'Tabs or spaces Tabs | Spaces',
      'endless'
    ]) {
      expect(classifyPollCommand(query), query).toEqual({
        kind: 'error',
        message: POLL_COMMAND_USAGE
      })
    }
    expect(POLL_COMMAND_USAGE).toBe('Use /poll Question? Option | Option (2–5 options).')
  })

  it('refuses a question or an answer that is too long, at the exact limit', () => {
    const question59 = `${'q'.repeat(59)}?`
    expect(classifyPollCommand(`${question59} a | b`)).toEqual(start(question59, ['a', 'b']))
    expect(classifyPollCommand(`${'q'.repeat(60)}? a | b`)).toEqual({
      kind: 'error',
      message: POLL_QUESTION_REFUSAL
    })
    // Code points, as the backend counts: 60 emoji are 60 characters.
    expect(classifyPollCommand(`${'🎮'.repeat(59)}? a | b`)).toMatchObject({ kind: 'poll' })
    expect(classifyPollCommand('? a | b')).toEqual({
      kind: 'error',
      message: POLL_QUESTION_REFUSAL
    })
    const answer25 = 'a'.repeat(25)
    expect(classifyPollCommand(`Q? ${answer25} | b`)).toEqual(start('Q?', [answer25, 'b']))
    expect(classifyPollCommand(`Q? ${'a'.repeat(26)} | b`)).toEqual({
      kind: 'error',
      message: POLL_OPTIONS_REFUSAL
    })
  })

  it('refuses the same answer twice, whatever its case', () => {
    expect(classifyPollCommand('Q? Tabs | tabs ')).toEqual({
      kind: 'error',
      message: POLL_DUPLICATE_REFUSAL
    })
  })

  it('reads end and cancel in any case', () => {
    expect(classifyPollCommand('end')).toEqual({ kind: 'poll', poll: { action: 'end' } })
    expect(classifyPollCommand(' END ')).toEqual({ kind: 'poll', poll: { action: 'end' } })
    expect(classifyPollCommand('Cancel')).toEqual({ kind: 'poll', poll: { action: 'cancel' } })
  })
})

describe('/poll in classifyComposerDraft', () => {
  it('is a local command, and // escapes it to chat', () => {
    expect(classifyComposerDraft('/poll')).toEqual({ kind: 'poll', poll: { action: 'open' } })
    expect(classifyComposerDraft(' /POLL Tabs or spaces? Tabs | Spaces ')).toEqual(
      start('Tabs or spaces?', ['Tabs', 'Spaces'])
    )
    expect(classifyComposerDraft('/poll end')).toEqual({ kind: 'poll', poll: { action: 'end' } })
    expect(classifyComposerDraft('/poll cancel')).toEqual({
      kind: 'poll',
      poll: { action: 'cancel' }
    })
    expect(classifyComposerDraft('/poll Tabs')).toEqual({
      kind: 'error',
      message: POLL_COMMAND_USAGE
    })
    expect(classifyComposerDraft('//poll Tabs or spaces? Tabs | Spaces')).toEqual({
      kind: 'chat',
      text: '/poll Tabs or spaces? Tabs | Spaces'
    })
    // Not a command name it knows: the unknown-command line lists /poll.
    const unknown = classifyComposerDraft('/pollx')
    expect(unknown).toMatchObject({ kind: 'error' })
    expect((unknown as { message: string }).message).toContain('/poll')
  })
})

describe('pollCompletions', () => {
  it('offers end and cancel under /poll once a letter is typed, only while a poll runs', () => {
    const open = { state: 'open' } as const
    expect(pollCompletions('/poll e', open)).toEqual([
      { value: '/poll end', hint: ' · End the poll now' }
    ])
    expect(pollCompletions('/poll C', open)).toEqual([
      { value: '/poll cancel', hint: ' · Cancel the poll' }
    ])
    // Counting: the votes have stopped, only cancel is left.
    expect(pollCompletions('/poll e', { state: 'counting' })).toEqual([])
    expect(pollCompletions('/poll c', { state: 'counting' })).toHaveLength(1)
    expect(pollCompletions('/poll e', { state: 'final' })).toEqual([])
    expect(pollCompletions('/poll e', null)).toEqual([])
    // `/poll` and Enter opens the popover: nothing to complete yet.
    expect(pollCompletions('/poll ', open)).toEqual([])
    expect(pollCompletions('/poll', open)).toBeNull()
    // A question being written gets no completions.
    expect(pollCompletions('/poll end it?', open)).toEqual([])
    expect(pollCompletions('/banner e', open)).toBeNull()
  })
})
