import { describe, expect, it } from 'vitest'

import {
  BUDDY_BEHAVIOUR_HOME,
  BUDDY_SAMPLE_FIELDS,
  BUDDY_STARTER_TEMPLATES,
  BUDDY_MODE_HINTS,
  BUDDY_POSTING_LABEL,
  BUDDY_POSTS_PROMISE,
  BUDDY_TEMPLATE_FIELDS,
  buddyBehaviourChips,
  buddyDisplayName,
  buddyModeChangeStep,
  buddyPostingConsentSentence,
  buddyPostingConsentTitle,
  greetingTemplateWarnings,
  resolveGreetingPreview
} from './buddy-auto-chat-view'

describe('Buddy in copy (plan 174 J2-20, F-26)', () => {
  it("uses the streamer's name when the character acts, else Buddy", () => {
    expect(buddyDisplayName('Grum')).toBe('Grum')
    expect(buddyDisplayName('  Nib  ')).toBe('Nib')
    expect(buddyDisplayName('')).toBe('Buddy')
    expect(buddyDisplayName(null)).toBe('Buddy')
    expect(buddyPostingConsentTitle('Grum')).toBe('Let Grum post as you?')
    expect(buddyPostingConsentSentence('Grum')).toBe(
      'Grum posts to your chats as you, on the platforms you stream to, only in the modes you turn on. You can read every message later in Buddy → Reports.'
    )
  })

  it('never writes "the Buddy": the feature is Buddy, with no article', () => {
    for (const line of [
      BUDDY_POSTS_PROMISE,
      ...Object.values(BUDDY_MODE_HINTS),
      buddyPostingConsentSentence(null)
    ]) {
      expect(line).not.toMatch(/\b[Tt]he Buddy\b/)
    }
  })
})

describe('Chat posting and the behaviour chips (plan 174 S3.14a, D7)', () => {
  it('governs only what Buddy posts: Off never means Buddy Live off', () => {
    expect(BUDDY_POSTING_LABEL).toBe('Chat posting')
    expect(BUDDY_MODE_HINTS.off).toBe('Nothing is posted.')
    for (const hint of Object.values(BUDDY_MODE_HINTS)) {
      expect(hint).not.toContain('Buddy Live')
    }
  })

  it('summarises each behaviour as a read-only chip that names its one home', () => {
    const chips = buddyBehaviourChips({
      greetings: {
        enabled: true,
        templates: [{ id: 't', kind: 'follow', text: 'Hi {name}', state: 'talk', enabled: true }]
      },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
    expect(chips.map((chip) => [chip.id, chip.text, chip.on])).toEqual([
      ['greetings', 'Greetings on', true],
      ['answers', 'Answers off', false],
      ['banter', 'Banter off', false]
    ])
    expect(BUDDY_BEHAVIOUR_HOME).toBe('Buddy → Chat')
    for (const chip of chips) {
      expect(chip.empty).toBe(false)
      expect(chip.name).toBe(`${chip.text}. Change it in Buddy → Chat.`)
    }
    // Plan 174 F-11: on with no line to post says so, never silently.
    const [greetings] = buddyBehaviourChips({
      greetings: { enabled: true, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
    expect(greetings).toMatchObject({ on: true, empty: true, text: 'Greetings on, no lines' })
    expect(greetings!.name).toContain('Nothing is posted until you add some in Buddy → Chat.')
  })
})

describe('greeting preview (plan 164 S-D5)', () => {
  it('fills known fields from the sample and collapses the gaps', () => {
    expect(
      resolveGreetingPreview(
        'Welcome {name} ({handle}) from {platform}!',
        BUDDY_SAMPLE_FIELDS.follow
      )
    ).toEqual({ text: 'Welcome new_friend (@new_friend) from Twitch!', unknown: [] })
    expect(
      resolveGreetingPreview(
        '{name} redeemed {reward} for {amount}',
        BUDDY_SAMPLE_FIELDS.redemption
      )
    ).toEqual({ text: 'hydration_hero redeemed Hydrate for 500 Diamonds', unknown: [] })
    expect(resolveGreetingPreview('{months} months', BUDDY_SAMPLE_FIELDS.follow).text).toBe(
      'months'
    )
  })

  it('keeps unknown fields literal and names each once', () => {
    expect(resolveGreetingPreview('Hi {name}, {nope} and {nope}', BUDDY_SAMPLE_FIELDS.sub)).toEqual(
      {
        text: 'Hi morgaesis, {nope} and {nope}',
        unknown: ['nope']
      }
    )
  })

  it('warns on an unknown field, never silently', () => {
    expect(greetingTemplateWarnings({ kind: 'follow', text: 'Welcome {nam}' })).toEqual([
      '{nam} is not a field and will be posted as written.'
    ])
    expect(greetingTemplateWarnings({ kind: 'follow', text: 'Welcome {name}' })).toEqual([])
  })

  it('warns when the text exceeds a cap on a platform it reaches (X takes 140)', () => {
    const long = `Welcome {name}! ${'x'.repeat(150)}`
    expect(greetingTemplateWarnings({ kind: 'follow', text: long })).toEqual([
      `X takes 140 characters; this one is ${'Welcome new_friend! '.length + 150}.`
    ])
    // Limited to Twitch: 200 is the cap, so no warning.
    expect(greetingTemplateWarnings({ kind: 'follow', platform: 'twitch', text: long })).toEqual([])
    // Over 200 everywhere.
    const longer = `{name} ${'y'.repeat(200)}`
    expect(greetingTemplateWarnings({ kind: 'raid', text: longer })).toEqual([
      `Twitch takes 200 characters; this one is ${'raider42 '.length + 200}.`
    ])
  })

  it('ships a starter set that only uses known fields', () => {
    const known = new Set(BUDDY_TEMPLATE_FIELDS.map((entry) => entry.field))
    for (const starter of BUDDY_STARTER_TEMPLATES) {
      const { unknown } = resolveGreetingPreview(starter.text, BUDDY_SAMPLE_FIELDS[starter.kind])
      expect(unknown).toEqual([])
      for (const match of starter.text.matchAll(/\{([a-z]+)\}/g)) {
        expect(known.has(match[1]!)).toBe(true)
      }
    }
  })
})

describe('mode changes (plan 164 S-D6)', () => {
  it('asks for consent the first time the mode leaves Off, and lands in Suggest', () => {
    expect(buddyModeChangeStep({ next: 'suggest', consented: false })).toBe('consent')
    expect(buddyModeChangeStep({ next: 'auto', consented: false })).toBe('consent')
    expect(buddyModeChangeStep({ next: 'off', consented: false })).toBe('apply')
  })

  it('never reaches Auto without its own second confirm', () => {
    expect(buddyModeChangeStep({ next: 'auto', consented: true })).toBe('confirm-auto')
    expect(buddyModeChangeStep({ next: 'suggest', consented: true })).toBe('apply')
    expect(buddyModeChangeStep({ next: 'off', consented: true })).toBe('apply')
  })
})
