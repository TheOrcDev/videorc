import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  COHOST_ACTIVITY_TEMPLATE_KINDS,
  COHOST_WELCOME_KINDS,
  type CohostGreetingTemplate
} from './backend'
import {
  BUDDY_BEHAVIOUR_HOME,
  BUDDY_BUILTIN_GREETINGS,
  BUDDY_SAMPLE_FIELDS,
  BUDDY_MODE_HINTS,
  BUDDY_POSTING_LABEL,
  BUDDY_POSTS_PROMISE,
  BUDDY_WELCOME_FIELDS,
  BUDDY_WELCOME_TITLES,
  buddyBehaviourChips,
  buddyDisplayName,
  buddyModeChangeStep,
  buddyPostingConsentSentence,
  buddyPostingConsentTitle,
  builtinGreeting,
  greetingTemplateWarnings,
  greetingWelcomes,
  greetingsAi,
  newGreetingTemplate,
  resolveGreetingLine,
  resolveGreetingPreview,
  resolveWelcomeLine,
  withWelcomeText
} from './buddy-auto-chat-view'

/** The shared fixture Rust's `BUILTIN_GREETINGS` asserts too (plan 192). */
const BUILTIN_FIXTURE = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/buddy-builtin-greetings.json', import.meta.url),
    'utf8'
  )
) as { version: number; lines: unknown[] }

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
      expect(chip.name).toBe(`${chip.text}. Change it in Buddy → Chat.`)
    }
  })

  it('never warns about an empty list: it posts the built-in lines (plan 192 D1)', () => {
    const [greetings] = buddyBehaviourChips({
      greetings: { enabled: true, templates: [] },
      answers: { enabled: false, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
    expect(greetings).toEqual({
      id: 'greetings',
      label: 'Greetings',
      on: true,
      text: 'Greetings on',
      name: 'Greetings on. Change it in Buddy → Chat.'
    })
  })

  it('says AI only when Buddy may write the greetings (plan 192 D3, D7)', () => {
    const autoChat = (enabled: boolean, ai?: boolean) => ({
      greetings: { enabled, templates: [], ...(ai === undefined ? {} : { ai }) },
      answers: { enabled: true, cooldownSeconds: 20 },
      banter: { enabled: false, cooldownSeconds: 240 }
    })
    const greetingsText = (...args: Parameters<typeof buddyBehaviourChips>): string =>
      buddyBehaviourChips(...args)[0]!.text
    expect(greetingsText(autoChat(true, true), { aiGreetings: true })).toBe('Greetings on · AI')
    // An older backend omits the switch: on, like Rust's default.
    expect(greetingsText(autoChat(true), { aiGreetings: true })).toBe('Greetings on · AI')
    expect(buddyBehaviourChips(autoChat(true, true), { aiGreetings: true })[0]!.name).toBe(
      'Greetings on · AI. Change it in Buddy → Chat.'
    )
    // Without Premium and cloud AI, the switch off, or Greetings off: no AI.
    expect(greetingsText(autoChat(true, true))).toBe('Greetings on')
    expect(greetingsText(autoChat(true, false), { aiGreetings: true })).toBe('Greetings on')
    expect(greetingsText(autoChat(false, true), { aiGreetings: true })).toBe('Greetings off')
    // Answers and Banter never say AI.
    expect(
      buddyBehaviourChips(autoChat(true, true), { aiGreetings: true }).map((chip) => chip.text)
    ).toEqual(['Greetings on · AI', 'Answers on', 'Banter off'])
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
})

describe('built-in greeting lines (plan 192 D1)', () => {
  it('equals the shared fixture, row for row (Rust asserts the same file)', () => {
    expect(BUILTIN_FIXTURE.version).toBe(1)
    expect(BUDDY_BUILTIN_GREETINGS).toStrictEqual(BUILTIN_FIXTURE.lines)
  })

  it('has one line for every kind, the welcomes first', () => {
    expect(BUDDY_BUILTIN_GREETINGS.map((line) => line.kind)).toEqual([
      ...COHOST_WELCOME_KINDS,
      ...COHOST_ACTIVITY_TEMPLATE_KINDS
    ])
    expect(builtinGreeting('first-time')).toEqual({
      kind: 'first-time',
      text: 'Hi {name}, welcome to the stream!',
      state: 'talk'
    })
    expect(builtinGreeting('raid').state).toBe('laugh')
  })

  it('uses only {name}, so a line reads right whatever a platform leaves empty', () => {
    for (const line of BUDDY_BUILTIN_GREETINGS) {
      const { unknown } = resolveGreetingPreview(line.text, BUDDY_SAMPLE_FIELDS[line.kind])
      expect(unknown).toEqual([])
      expect([...line.text.matchAll(/\{([a-z]+)\}/g)].map((match) => match[1])).toEqual(['name'])
      expect(greetingTemplateWarnings({ kind: line.kind, text: line.text })).toEqual([])
    }
  })

  it('starts a new line from the built-in one, never empty (the settings refuse empty)', () => {
    expect(newGreetingTemplate('raid')).toMatchObject({
      kind: 'raid',
      text: '{name} is raiding! Welcome, everyone!',
      state: 'laugh',
      enabled: true
    })
    expect(newGreetingTemplate('follow', { platform: 'kick' })).toMatchObject({
      kind: 'follow',
      platform: 'kick',
      text: 'Welcome, {name}! Thanks for the follow.'
    })
  })
})

describe('what a kind posts (plan 192 D1, pick_template mirrored)', () => {
  const line = (
    id: string,
    overrides: Partial<CohostGreetingTemplate> = {}
  ): CohostGreetingTemplate => ({
    id,
    kind: 'follow',
    text: `Line ${id}`,
    state: 'talk',
    enabled: true,
    ...overrides
  })

  it('posts the built-in line for a kind with no line of yours, even from an empty list', () => {
    expect(resolveGreetingLine([], 'follow')).toEqual({
      source: 'built-in',
      line: builtinGreeting('follow')
    })
    expect(resolveGreetingLine([line('a', { kind: 'sub' })], 'follow')).toEqual({
      source: 'built-in',
      line: builtinGreeting('follow')
    })
  })

  it('posts your enabled lines over the built-in one', () => {
    const lines = [line('a'), line('b', { enabled: false }), line('c')]
    expect(resolveGreetingLine(lines, 'follow')).toEqual({
      source: 'yours',
      templates: [lines[0], lines[2]]
    })
  })

  it('is off when every line of the kind is switched off', () => {
    expect(
      resolveGreetingLine([line('a', { enabled: false }), line('b', { enabled: false })], 'follow')
    ).toEqual({ source: 'off' })
  })

  it('matches the platform when one is named; another platform gets the built-in line', () => {
    const twitch = line('a', { platform: 'twitch' })
    expect(resolveGreetingLine([twitch], 'follow', 'twitch')).toEqual({
      source: 'yours',
      templates: [twitch]
    })
    expect(resolveGreetingLine([twitch, line('b')], 'follow', 'kick')).toEqual({
      source: 'yours',
      templates: [expect.objectContaining({ id: 'b' })]
    })
    expect(resolveGreetingLine([twitch], 'follow', 'kick')).toEqual({
      source: 'built-in',
      line: builtinGreeting('follow')
    })
  })
})

describe('welcomes (plan 192 D2, S1.1)', () => {
  it('names the two rows word for word and offers only the chat fields', () => {
    expect(BUDDY_WELCOME_TITLES).toEqual({
      'first-time': 'First-time chatters',
      returning: 'Returning chatters'
    })
    expect(BUDDY_WELCOME_FIELDS.map((entry) => entry.field)).toEqual(['name', 'handle', 'platform'])
  })

  it("reads an older backend's missing switch and welcomes as Rust's defaults", () => {
    expect(greetingsAi({})).toBe(true)
    expect(greetingsAi({ ai: false })).toBe(false)
    expect(greetingWelcomes({})).toEqual({
      firstTime: { enabled: true },
      returning: { enabled: true }
    })
    const stored = { firstTime: { enabled: false }, returning: { enabled: true, text: 'Yo' } }
    expect(greetingWelcomes({ welcomes: stored })).toBe(stored)
  })

  it('posts your line, else the built-in one, and nothing when switched off', () => {
    expect(resolveWelcomeLine({ enabled: true }, 'first-time')).toEqual({
      source: 'built-in',
      text: 'Hi {name}, welcome to the stream!',
      state: 'talk'
    })
    expect(
      resolveWelcomeLine({ enabled: true, text: ' Yo {name}! ', state: 'laugh' }, 'returning')
    ).toEqual({ source: 'yours', text: 'Yo {name}!', state: 'laugh' })
    expect(resolveWelcomeLine({ enabled: false, text: 'Yo' }, 'returning')).toEqual({
      source: 'off'
    })
  })

  it('saves an empty line as absent, never as an empty string or null', () => {
    expect(withWelcomeText({ enabled: true, text: 'Yo', state: 'laugh' }, '   ')).toStrictEqual({
      enabled: true,
      state: 'laugh'
    })
    expect(withWelcomeText({ enabled: true, reaction: 'wave' }, ' Hey {name} ')).toStrictEqual({
      enabled: true,
      reaction: 'wave',
      text: 'Hey {name}'
    })
  })

  it('warns about a welcome over the X cap: a welcome reaches every platform', () => {
    const long = `Hi {name}! ${'x'.repeat(140)}`
    expect(greetingTemplateWarnings({ kind: 'first-time', text: long })).toEqual([
      `X takes 140 characters; this one is ${'Hi first_timer! '.length + 140}.`
    ])
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
