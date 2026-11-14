import { describe, expect, it } from 'vitest'

import {
  BUDDY_COMMAND,
  BUDDY_COMMAND_LEGACY,
  BUDDY_EMPTY_SENTENCE,
  BUDDY_SENTENCE_MAX_CHARS,
  BUDDY_TOO_LONG,
  classifyBuddyCommand,
  isFinalActAnswer
} from './buddy-act'
import { classifyComposerDraft } from './session-markers'

// Plan 209 S20: `/buddy <words>` in the Stream Manager's composer.

describe('/sidekick in the composer', () => {
  it('takes the words after /sidekick as one sentence, never a chat post', () => {
    expect(classifyComposerDraft('/sidekick switch to BRB and play the drum roll')).toEqual({
      kind: 'buddy',
      sentence: 'switch to BRB and play the drum roll'
    })
    expect(classifyComposerDraft('  /SIDEKICK   move yourself\n to the top left  ')).toEqual({
      kind: 'buddy',
      sentence: 'move yourself to the top left'
    })
  })

  it('keeps /buddy as a silent alias for two releases (plan 236 D4)', () => {
    expect(BUDDY_COMMAND).toBe('/sidekick')
    expect(BUDDY_COMMAND_LEGACY).toBe('/buddy')
    expect(classifyComposerDraft('/buddy switch to BRB')).toEqual({
      kind: 'buddy',
      sentence: 'switch to BRB'
    })
    expect(classifyComposerDraft('  /BUDDY   move yourself\n to the top left  ')).toEqual({
      kind: 'buddy',
      sentence: 'move yourself to the top left'
    })
    expect(classifyComposerDraft('/buddy')).toEqual({
      kind: 'error',
      message: BUDDY_EMPTY_SENTENCE
    })
    // The unknown-command line names only /sidekick.
    const unknown = classifyComposerDraft('/nope')
    expect(unknown.kind === 'error' && unknown.message).toContain('/sidekick [words]')
    expect(unknown.kind === 'error' && unknown.message).not.toContain('/buddy')
  })

  it('asks for words when there are none, and refuses a sentence past 500 characters', () => {
    expect(classifyComposerDraft('/sidekick')).toEqual({
      kind: 'error',
      message: BUDDY_EMPTY_SENTENCE
    })
    expect(classifyComposerDraft('/sidekick    ')).toEqual({
      kind: 'error',
      message: BUDDY_EMPTY_SENTENCE
    })
    expect(classifyBuddyCommand('x'.repeat(BUDDY_SENTENCE_MAX_CHARS))).toEqual({
      kind: 'buddy',
      sentence: 'x'.repeat(BUDDY_SENTENCE_MAX_CHARS)
    })
    expect(classifyBuddyCommand('x'.repeat(BUDDY_SENTENCE_MAX_CHARS + 1))).toEqual({
      kind: 'error',
      message: BUDDY_TOO_LONG
    })
  })

  it('is its own command: /sidekickx, /buddyx, // and plain words are not', () => {
    expect(classifyComposerDraft('/sidekickx hi').kind).toBe('error')
    expect(classifyComposerDraft('/buddyx hi').kind).toBe('error')
    expect(classifyComposerDraft('//sidekick hi')).toEqual({ kind: 'chat', text: '/sidekick hi' })
    expect(classifyComposerDraft('//buddy hi')).toEqual({ kind: 'chat', text: '/buddy hi' })
    expect(classifyComposerDraft('sidekick switch to BRB')).toEqual({
      kind: 'chat',
      text: 'sidekick switch to BRB'
    })
  })

  it('reads working as not yet final', () => {
    expect(isFinalActAnswer({ actId: 'a', status: 'working', message: 'Asking Sidekick…' })).toBe(
      false
    )
    for (const status of ['done', 'refused', 'unavailable', 'not-found'] as const) {
      expect(isFinalActAnswer({ actId: 'a', status, message: 'x' })).toBe(true)
    }
  })
})
