import { describe, expect, it } from 'vitest'

import {
  BUDDY_EMPTY_SENTENCE,
  BUDDY_SENTENCE_MAX_CHARS,
  BUDDY_TOO_LONG,
  classifyBuddyCommand,
  isFinalActAnswer
} from './buddy-act'
import { classifyComposerDraft } from './session-markers'

// Plan 209 S20: `/buddy <words>` in the Stream Manager's composer.

describe('/buddy in the composer', () => {
  it('takes the words after /buddy as one sentence, never a chat post', () => {
    expect(classifyComposerDraft('/buddy switch to BRB and play the drum roll')).toEqual({
      kind: 'buddy',
      sentence: 'switch to BRB and play the drum roll'
    })
    expect(classifyComposerDraft('  /BUDDY   move yourself\n to the top left  ')).toEqual({
      kind: 'buddy',
      sentence: 'move yourself to the top left'
    })
  })

  it('asks for words when there are none, and refuses a sentence past 500 characters', () => {
    expect(classifyComposerDraft('/buddy')).toEqual({
      kind: 'error',
      message: BUDDY_EMPTY_SENTENCE
    })
    expect(classifyComposerDraft('/buddy    ')).toEqual({
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

  it('is its own command: /buddyx, // and plain words are not', () => {
    expect(classifyComposerDraft('/buddyx hi').kind).toBe('error')
    expect(classifyComposerDraft('//buddy hi')).toEqual({ kind: 'chat', text: '/buddy hi' })
    expect(classifyComposerDraft('buddy switch to BRB')).toEqual({
      kind: 'chat',
      text: 'buddy switch to BRB'
    })
  })

  it('reads working as not yet final', () => {
    expect(isFinalActAnswer({ actId: 'a', status: 'working', message: 'Asking Buddy…' })).toBe(
      false
    )
    for (const status of ['done', 'refused', 'unavailable', 'not-found'] as const) {
      expect(isFinalActAnswer({ actId: 'a', status, message: 'x' })).toBe(true)
    }
  })
})
