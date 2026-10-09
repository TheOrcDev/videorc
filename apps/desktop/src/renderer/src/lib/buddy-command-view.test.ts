import { describe, expect, it } from 'vitest'

import type { CohostCommand } from './backend'
import {
  COMMAND_STRIP_VISIBLE_MS,
  REMOVE_CONFIRM_LABELS,
  REMOVING_MESSAGES_PAUSED,
  VOICE_COMMANDS_PAUSED,
  WAKE_WORD_DESCRIPTION,
  WAKE_WORD_LABEL,
  YOUTUBE_ALWAYS_CONFIRMS,
  commandAvailabilityLines,
  commandChooserView,
  commandConfirmView,
  commandStripView,
  openCommandCardId,
  removalLimitsLine
} from './buddy-command-view'
import { BUDDY_REMOVAL_LIMITS } from './buddy-tab-view'

const NOW = Date.parse('2026-10-04T12:00:10Z')

const target = {
  messageId: 's1:twitch:t:m-1',
  authorName: 'coders_x',
  platform: 'twitch' as const,
  excerpt: 'how do I center a div'
}

function command(patch: Partial<CohostCommand> = {}): CohostCommand {
  return {
    id: 'cmd-1',
    heard: 'buddy highlight the comment from coders x',
    kind: 'highlight',
    status: 'done',
    message: "Highlighted coders_x's comment.",
    target,
    at: '2026-10-04T12:00:08Z',
    ...patch
  }
}

describe('commandStripView (plan 140, S6 part B)', () => {
  it('says what Buddy heard, then what it did', () => {
    expect(commandStripView(command(), NOW)).toEqual({
      commandId: 'cmd-1',
      heard: 'Heard: “buddy highlight the comment from coders x”',
      message: "Highlighted coders_x's comment.",
      quiet: false,
      fading: false
    })
  })

  it('reads not found, refused and unavailable quietly', () => {
    for (const status of ['not-found', 'refused', 'unavailable'] as const) {
      expect(commandStripView(command({ status }), NOW)?.quiet).toBe(true)
    }
    for (const status of ['done', 'cancelled', 'expired'] as const) {
      expect(commandStripView(command({ status }), NOW)?.quiet).toBe(false)
    }
    expect(
      commandStripView(
        command({
          kind: 'unknown',
          status: 'not-found',
          message: "Buddy didn't catch that: 'blorp'"
        }),
        NOW
      )
    ).toMatchObject({ quiet: true, message: "Buddy didn't catch that: 'blorp'" })
  })

  it('fades a finished command after a few seconds, and keeps an open one', () => {
    const finished = command({ at: '2026-10-04T12:00:05Z' })
    expect(commandStripView(finished, NOW)?.fading).toBe(true)
    expect(
      commandStripView(finished, Date.parse(finished.at) + COMMAND_STRIP_VISIBLE_MS)
    ).toBeNull()
    const open = command({ status: 'ambiguous', at: '2026-10-04T11:00:00Z' })
    expect(commandStripView(open, NOW)).not.toBeNull()
    expect(commandStripView(null, NOW)).toBeNull()
    expect(commandStripView(command({ at: 'not a time' }), NOW)).toBeNull()
  })
})

describe('commandChooserView', () => {
  const candidates = [
    target,
    { ...target, messageId: 'm-2', authorName: 'coders_y', platform: 'youtube' as const },
    { ...target, messageId: 'm-3', authorName: 'coder', excerpt: '  hi  ' },
    { ...target, messageId: 'm-4', authorName: 'too_many' }
  ]

  it('lists up to three comments with their keys and the time left', () => {
    const view = commandChooserView(
      command({
        status: 'ambiguous',
        message: 'Which comment from coders?',
        candidates,
        expiresAt: '2026-10-04T12:00:25Z'
      }),
      NOW
    )
    expect(view?.title).toBe('Which comment from coders?')
    expect(view?.timer).toBe('Expires in 15s')
    expect(view?.candidates.map((candidate) => [candidate.key, candidate.authorName])).toEqual([
      ['1', 'coders_x'],
      ['2', 'coders_y'],
      ['3', 'coder']
    ])
    expect(view?.candidates[1].platformLabel).toBe('YouTube')
    expect(view?.candidates[2].excerpt).toBe('hi')
  })

  it('exists only for an ambiguous command with candidates', () => {
    expect(commandChooserView(command({ status: 'ambiguous' }), NOW)).toBeNull()
    expect(commandChooserView(command({ candidates }), NOW)).toBeNull()
    expect(
      commandChooserView(command({ status: 'ambiguous', message: '', candidates }), NOW)?.title
    ).toBe('Which comment?')
  })
})

describe('commandConfirmView', () => {
  const flagged = command({
    status: 'confirm',
    message: 'Buddy flagged this (harassment). Show it anyway?',
    expiresAt: '2026-10-04T12:00:28Z'
  })

  it('asks before showing a comment Buddy flagged', () => {
    expect(commandConfirmView(flagged, NOW)).toEqual({
      commandId: 'cmd-1',
      title: 'Buddy flagged this (harassment). Show it anyway?',
      target: { ...target, platformLabel: 'Twitch' },
      timer: 'Expires in 18s',
      busy: false
    })
    expect(commandConfirmView(flagged, NOW, true)?.busy).toBe(true)
  })

  it('never doubles a removal card, and waits while running', () => {
    const removal = command({
      kind: 'remove',
      status: 'confirm',
      operationId: '6f1c2e9a-3b7d-4c51-9e2f-0a1b2c3d4e5f',
      expiresAt: '2026-10-04T12:00:28Z'
    })
    expect(commandConfirmView(removal, NOW)).toBeNull()
    // A removal card still opening (no operationId) shows nothing either.
    expect(commandConfirmView({ ...removal, operationId: undefined }, NOW)).toBeNull()
    expect(openCommandCardId(removal, NOW)).toBeNull()
    expect(commandConfirmView({ ...flagged, expiresAt: undefined }, NOW)?.busy).toBe(true)
    expect(openCommandCardId(flagged, NOW)).toBe('cmd-1')
  })
})

describe('the Buddy tab copy for voice commands', () => {
  it('names the kill switches only when paused', () => {
    expect(commandAvailabilityLines(undefined)).toEqual([])
    expect(commandAvailabilityLines({ voiceCommands: 'on', remove: 'on' })).toEqual([])
    expect(commandAvailabilityLines({ voiceCommands: 'paused', remove: 'paused' })).toEqual([
      'Voice commands are paused by Videorc.',
      'Removing messages is paused by Videorc.'
    ])
    expect(commandAvailabilityLines({ voiceCommands: 'on', remove: 'paused' })).toEqual([
      REMOVING_MESSAGES_PAUSED
    ])
    expect(VOICE_COMMANDS_PAUSED).toBe('Voice commands are paused by Videorc.')
  })

  it('matches the web words, and the numbers follow the mode', () => {
    expect(WAKE_WORD_LABEL).toBe('Commands need “Buddy” first')
    expect(REMOVE_CONFIRM_LABELS).toEqual({
      confirm: 'Confirm first',
      countdown: '5-second countdown'
    })
    expect(YOUTUBE_ALWAYS_CONFIRMS).toBe('YouTube always asks you to confirm.')
    expect(removalLimitsLine('confirm')).toBe(BUDDY_REMOVAL_LIMITS)
    expect(removalLimitsLine('countdown')).toContain('after 5 seconds unless you cancel')
    expect(removalLimitsLine('countdown')).toContain('At most 10 removals a minute.')
    for (const line of [
      WAKE_WORD_LABEL,
      WAKE_WORD_DESCRIPTION,
      removalLimitsLine('countdown'),
      YOUTUBE_ALWAYS_CONFIRMS
    ]) {
      expect(line).not.toContain('—')
      expect(line).not.toMatch(/co-?host/i)
    }
  })
})
