import { describe, expect, it } from 'vitest'

import { buddyOffOutputsNotice, sidekickWritesLines } from '@/lib/buddy-output-notice'

const LIVE_AND_OFF = {
  enabled: true,
  onAir: true,
  showOnStream: false,
  showInRecording: false,
  name: 'Golmar'
}

describe('buddyOffOutputsNotice', () => {
  it('says so when Sidekick Live runs on air with both outputs off', () => {
    expect(buddyOffOutputsNotice(LIVE_AND_OFF)).toEqual({
      title: "Golmar isn't on stream.",
      detail: "Viewers can't see it, its bubbles or its reactions.",
      action: 'Show on stream'
    })
  })

  it('treats a seed without the recording switch as off (an older Studio)', () => {
    const { showInRecording: _dropped, ...withoutRecording } = LIVE_AND_OFF
    expect(buddyOffOutputsNotice(withoutRecording)?.title).toBe("Golmar isn't on stream.")
    expect(buddyOffOutputsNotice({ ...withoutRecording, showInRecording: null })).not.toBeNull()
  })

  it("falls back to the default avatar's name, Flint, for a nameless persona (plan 239 D2)", () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, name: null })?.title).toBe(
      "Flint isn't on stream."
    )
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, name: '  ' })?.title).toBe(
      "Flint isn't on stream."
    )
  })

  it('stays quiet while an output carries the avatar', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: true })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showInRecording: true })).toBeNull()
  })

  it('stays quiet while Sidekick Live is off, nothing is on air, or the relay has no avatar', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, enabled: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, onAir: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: null })).toBeNull()
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, showOnStream: undefined })).toBeNull()
  })
})

describe('buddyOffOutputsNotice and how the avatar talks (plan 211 D9)', () => {
  const BUBBLE_DETAIL = "Viewers can't see its bubble, so Bubble says nothing."

  it('shows in Bubble with Sidekick Live off: the built-in greetings need no Sidekick Live', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, enabled: false, talk: 'bubble' })).toEqual({
      title: "Golmar isn't on stream.",
      detail: BUBBLE_DETAIL,
      action: 'Show on stream'
    })
  })

  it('says the Bubble detail with Sidekick Live on too', () => {
    expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, talk: 'bubble' })?.detail).toBe(BUBBLE_DETAIL)
  })

  it('keeps Suggest and Off as they were: only with Sidekick Live on, the old detail', () => {
    for (const talk of ['suggest', 'off'] as const) {
      expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, talk })).toEqual({
        title: "Golmar isn't on stream.",
        detail: "Viewers can't see it, its bubbles or its reactions.",
        action: 'Show on stream'
      })
      expect(buddyOffOutputsNotice({ ...LIVE_AND_OFF, enabled: false, talk })).toBeNull()
    }
  })

  it('stays quiet in Bubble off air, with the avatar on an output, or before the relay knows', () => {
    const bubble = { ...LIVE_AND_OFF, enabled: false, talk: 'bubble' as const }
    expect(buddyOffOutputsNotice({ ...bubble, onAir: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...bubble, showOnStream: true })).toBeNull()
    expect(buddyOffOutputsNotice({ ...bubble, showInRecording: true })).toBeNull()
    expect(buddyOffOutputsNotice({ ...bubble, showOnStream: null })).toBeNull()
    // Settings not loaded yet: like Buddy Live alone.
    expect(buddyOffOutputsNotice({ ...bubble, talk: null })).toBeNull()
    expect(buddyOffOutputsNotice({ ...bubble, talk: undefined })).toBeNull()
  })
})

// Plan 239 D3: Sidekick writes, the avatar says. While Sidekick Live writes
// lines in Bubble and the avatar is on no output, the notice says those lines
// have nowhere to show and offers Use Suggest beside Show on stream.
describe("buddyOffOutputsNotice while Sidekick writes the avatar's lines (plan 239 D3)", () => {
  const WRITING_IN_BUBBLE = { ...LIVE_AND_OFF, talk: 'bubble' as const, sidekickWrites: true }

  it('offers two ways out in Bubble with Sidekick Live on: Show on stream and Use Suggest', () => {
    expect(buddyOffOutputsNotice(WRITING_IN_BUBBLE)).toEqual({
      title: "Golmar isn't on stream.",
      detail:
        "Viewers can't see its bubble, so Sidekick's lines have nowhere to show. Show it, or use Suggest to post them as cards.",
      action: 'Show on stream',
      secondaryAction: 'Use Suggest'
    })
  })

  it('keeps one action while Sidekick writes nothing, or Sidekick Live is off', () => {
    for (const input of [
      { ...WRITING_IN_BUBBLE, sidekickWrites: false },
      { ...WRITING_IN_BUBBLE, sidekickWrites: undefined },
      { ...WRITING_IN_BUBBLE, enabled: false }
    ]) {
      expect(buddyOffOutputsNotice(input)).toEqual({
        title: "Golmar isn't on stream.",
        detail: "Viewers can't see its bubble, so Bubble says nothing.",
        action: 'Show on stream'
      })
    }
  })

  it('never offers Use Suggest when the lines are already cards, or talk is Off', () => {
    for (const talk of ['suggest', 'off'] as const) {
      const notice = buddyOffOutputsNotice({ ...WRITING_IN_BUBBLE, talk })
      expect(notice?.action).toBe('Show on stream')
      expect(notice?.secondaryAction).toBeUndefined()
    }
  })

  it('stays quiet like the others: off air, or the avatar on an output', () => {
    expect(buddyOffOutputsNotice({ ...WRITING_IN_BUBBLE, onAir: false })).toBeNull()
    expect(buddyOffOutputsNotice({ ...WRITING_IN_BUBBLE, showOnStream: true })).toBeNull()
    expect(buddyOffOutputsNotice({ ...WRITING_IN_BUBBLE, showInRecording: true })).toBeNull()
  })
})

describe('sidekickWritesLines (plan 239 D3)', () => {
  const quiet = {
    answers: { enabled: false },
    banter: { enabled: false },
    greetings: { enabled: false, ai: true }
  }

  it('is true while Answers or Banter is on', () => {
    expect(sidekickWritesLines({ ...quiet, answers: { enabled: true } })).toBe(true)
    expect(sidekickWritesLines({ ...quiet, banter: { enabled: true } })).toBe(true)
  })

  it('counts greetings only while they are on and written with AI, which an older backend omits (on)', () => {
    expect(sidekickWritesLines({ ...quiet, greetings: { enabled: true, ai: true } })).toBe(true)
    expect(sidekickWritesLines({ ...quiet, greetings: { enabled: true } })).toBe(true)
    // The greeting lines alone are the avatar's, not Sidekick's writing.
    expect(sidekickWritesLines({ ...quiet, greetings: { enabled: true, ai: false } })).toBe(false)
    expect(sidekickWritesLines({ ...quiet, greetings: { enabled: false, ai: true } })).toBe(false)
  })

  it('is false with nothing on, or before the settings load', () => {
    expect(sidekickWritesLines(quiet)).toBe(false)
    expect(sidekickWritesLines(null)).toBe(false)
    expect(sidekickWritesLines(undefined)).toBe(false)
  })
})
