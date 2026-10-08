import { describe, expect, it } from 'vitest'

import {
  GOLEM_SAMPLE_FIELDS,
  GOLEM_STARTER_TEMPLATES,
  GOLEM_TEMPLATE_FIELDS,
  golemModeChangeStep,
  greetingTemplateWarnings,
  resolveGreetingPreview
} from './golem-auto-chat-view'

describe('greeting preview (plan 164 S-D5)', () => {
  it('fills known fields from the sample and collapses the gaps', () => {
    expect(
      resolveGreetingPreview(
        'Welcome {name} ({handle}) from {platform}!',
        GOLEM_SAMPLE_FIELDS.follow
      )
    ).toEqual({ text: 'Welcome new_friend (@new_friend) from Twitch!', unknown: [] })
    expect(
      resolveGreetingPreview(
        '{name} redeemed {reward} for {amount}',
        GOLEM_SAMPLE_FIELDS.redemption
      )
    ).toEqual({ text: 'hydration_hero redeemed Hydrate for 500 Diamonds', unknown: [] })
    expect(resolveGreetingPreview('{months} months', GOLEM_SAMPLE_FIELDS.follow).text).toBe(
      'months'
    )
  })

  it('keeps unknown fields literal and names each once', () => {
    expect(resolveGreetingPreview('Hi {name}, {nope} and {nope}', GOLEM_SAMPLE_FIELDS.sub)).toEqual(
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
    const known = new Set(GOLEM_TEMPLATE_FIELDS.map((entry) => entry.field))
    for (const starter of GOLEM_STARTER_TEMPLATES) {
      const { unknown } = resolveGreetingPreview(starter.text, GOLEM_SAMPLE_FIELDS[starter.kind])
      expect(unknown).toEqual([])
      for (const match of starter.text.matchAll(/\{([a-z]+)\}/g)) {
        expect(known.has(match[1]!)).toBe(true)
      }
    }
  })
})

describe('mode changes (plan 164 S-D6)', () => {
  it('asks for consent the first time the mode leaves Off, and lands in Suggest', () => {
    expect(golemModeChangeStep({ next: 'suggest', consented: false })).toBe('consent')
    expect(golemModeChangeStep({ next: 'auto', consented: false })).toBe('consent')
    expect(golemModeChangeStep({ next: 'off', consented: false })).toBe('apply')
  })

  it('never reaches Auto without its own second confirm', () => {
    expect(golemModeChangeStep({ next: 'auto', consented: true })).toBe('confirm-auto')
    expect(golemModeChangeStep({ next: 'suggest', consented: true })).toBe('apply')
    expect(golemModeChangeStep({ next: 'off', consented: true })).toBe('apply')
  })
})
