import { describe, expect, it } from 'vitest'

import type { LiveChatMessage, LiveChatProviderState, PollStatus } from '@/lib/backend'
import {
  DEFAULT_POLL_DRAFT,
  POLL_ALREADY_RUNNING,
  POLL_CARD_UNAVAILABLE,
  POLL_DRAFT_STORAGE_KEY,
  POLL_NOT_LIVE,
  POLL_NO_CHAT,
  POLL_OPEN_SKEW_MS,
  POLL_VERTICAL_CANT_VOTE,
  checkPollDraft,
  foldedPollVoteIds,
  loadPollDraft,
  pollFoldWindow,
  pollFoldsMessage,
  pollPopoverMode,
  pollRunning,
  pollStartBlockedReason,
  pollStartFromCommand,
  pollStartReason,
  pollTallyView,
  rememberPollWindows,
  savePollDraft,
  type PollDraft
} from './poll-view'

// Plan 188 S5: the Stream Manager's poll model: the popover's states, the
// form and its remembered draft, the tally, and which chat rows fold (D5).

const OPENED = '2026-10-22T12:00:00.000Z'
const OPENED_MS = Date.parse(OPENED)

const poll = (overrides: Partial<PollStatus> = {}): PollStatus => ({
  pollId: 'poll-1',
  sessionId: 's1',
  question: 'Tabs or spaces?',
  options: [
    { label: 'Tabs', votes: 0 },
    { label: 'Spaces', votes: 0 }
  ],
  totalVotes: 0,
  byPlatform: [],
  state: 'open',
  openedAt: OPENED,
  closesAt: '2026-10-22T12:01:00.000Z',
  durationSeconds: 60,
  postInChat: true,
  card: 'shown',
  cardLegs: { primary: true, auxiliary: false },
  cardAvailable: true,
  winners: [],
  countingPlatforms: ['youtube', 'twitch'],
  pausedPlatforms: [],
  ...overrides
})

const provider = (overrides: Partial<LiveChatProviderState> = {}): LiveChatProviderState => ({
  id: 'twitch',
  platform: 'twitch',
  read: 'ready',
  write: 'ready',
  state: 'connected',
  message: 'Connected',
  ...overrides
})

describe('pollRunning and pollPopoverMode', () => {
  it('runs while open or counting, and shows the form, the tally or the result', () => {
    expect(pollRunning(poll())).toBe(true)
    expect(pollRunning(poll({ state: 'counting' }))).toBe(true)
    expect(pollRunning(poll({ state: 'final' }))).toBe(false)
    expect(pollRunning(null)).toBe(false)
    expect(pollPopoverMode(null, false)).toBe('create')
    // A cancelled poll reads as the create state.
    expect(pollPopoverMode(poll({ state: 'cancelled' }), false)).toBe('create')
    expect(pollPopoverMode(poll(), false)).toBe('live')
    expect(pollPopoverMode(poll({ state: 'counting' }), true)).toBe('live')
    expect(pollPopoverMode(poll({ state: 'final' }), false)).toBe('final')
    // New poll… goes back to the form until the next poll starts.
    expect(pollPopoverMode(poll({ state: 'final' }), true)).toBe('create')
  })
})

describe('pollStartBlockedReason', () => {
  it('says why in the backend words: running poll, then not live, then no chat', () => {
    const providers = [provider()]
    expect(pollStartBlockedReason({ live: true, providers, poll: null })).toBeNull()
    expect(pollStartBlockedReason({ live: true, providers, poll: poll({ state: 'final' }) })).toBe(
      null
    )
    expect(pollStartBlockedReason({ live: true, providers, poll: poll() })).toBe(
      POLL_ALREADY_RUNNING
    )
    expect(pollStartBlockedReason({ live: false, providers, poll: null })).toBe(POLL_NOT_LIVE)
    expect(pollStartBlockedReason({ live: true, providers: [], poll: null })).toBe(POLL_NO_CHAT)
    // A chat that can't be read is no chat; a connecting one will be.
    for (const unreadable of [
      provider({ read: 'unavailable' }),
      provider({ state: 'failed', read: 'failed' }),
      provider({ state: 'disabled' }),
      provider({ state: 'unsupported' })
    ]) {
      expect(
        pollStartBlockedReason({ live: true, providers: [unreadable], poll: null }),
        JSON.stringify(unreadable)
      ).toBe(POLL_NO_CHAT)
    }
    expect(
      pollStartBlockedReason({
        live: true,
        providers: [provider({ state: 'connecting', read: 'connecting' })],
        poll: null
      })
    ).toBeNull()
    expect(POLL_NOT_LIVE).toBe('Go live to start a poll.')
    expect(POLL_NO_CHAT).toBe("No chat is connected, so there's nobody to vote.")
    expect(POLL_ALREADY_RUNNING).toBe('End the current poll first.')
  })
})

describe('checkPollDraft', () => {
  const draft = (overrides: Partial<PollDraft>): PollDraft => ({ ...DEFAULT_POLL_DRAFT, ...overrides })

  it('sends the trimmed poll with blank rows left out and the chosen duration', () => {
    expect(
      checkPollDraft(
        draft({
          question: '  Tabs or spaces? ',
          options: [' Tabs ', '', 'Spaces'],
          duration: 'none',
          postInChat: false
        })
      )
    ).toEqual({
      questionError: null,
      optionErrors: [null, null, null],
      missing: null,
      params: {
        question: 'Tabs or spaces?',
        options: ['Tabs', 'Spaces'],
        durationSeconds: null,
        postInChat: false
      }
    })
    expect(
      checkPollDraft(draft({ question: 'Q?', options: ['a', 'b'], duration: '300' })).params
        ?.durationSeconds
    ).toBe(300)
  })

  it('marks a field over its limit, at the exact limit', () => {
    expect(checkPollDraft(draft({ question: 'q'.repeat(60), options: ['a', 'b'] })).params).not.toBe(
      null
    )
    const long = checkPollDraft(
      draft({ question: 'q'.repeat(61), options: ['a'.repeat(25), 'b'.repeat(26)] })
    )
    expect(long.questionError).toBe('Up to 60 characters.')
    expect(long.optionErrors).toEqual([null, 'Up to 25 characters.'])
    expect(long.params).toBeNull()
    expect(pollStartReason(null, long)).toBe('Fix the marked fields first.')
  })

  it('marks a repeated answer under its second row', () => {
    const check = checkPollDraft(draft({ question: 'Q?', options: ['Tabs', 'Spaces', ' tabs'] }))
    expect(check.optionErrors).toEqual([null, null, 'Same as option 1.'])
    expect(check.params).toBeNull()
  })

  it('says what is missing before Start poll runs, after the session reasons', () => {
    const empty = checkPollDraft(DEFAULT_POLL_DRAFT)
    expect(empty.missing).toBe('Ask a question first.')
    expect(pollStartReason(null, empty)).toBe('Ask a question first.')
    expect(pollStartReason(POLL_NOT_LIVE, empty)).toBe(POLL_NOT_LIVE)
    const one = checkPollDraft(draft({ question: 'Q?', options: ['Tabs', ' '] }))
    expect(one.missing).toBe('Add at least 2 options.')
    expect(one.questionError).toBeNull()
  })

  it('starts /poll with the remembered duration and Post in chat', () => {
    expect(
      pollStartFromCommand(
        { question: 'Q?', options: ['a', 'b'] },
        draft({ duration: '120', postInChat: false })
      )
    ).toEqual({ question: 'Q?', options: ['a', 'b'], durationSeconds: 120, postInChat: false })
  })
})

describe('the remembered draft', () => {
  const memory = (): Storage => {
    const values = new Map<string, string>()
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value)
    } as Storage
  }

  it('round-trips the last question, answers, duration and Post in chat', () => {
    const storage = memory()
    const last: PollDraft = {
      question: 'Next game?',
      options: ['Hades', 'Celeste', 'Tunic'],
      duration: '120',
      postInChat: false
    }
    savePollDraft(storage, last)
    expect(loadPollDraft(storage)).toEqual(last)
  })

  it('reads anything odd as the default, and never throws', () => {
    const storage = memory()
    expect(loadPollDraft(undefined)).toEqual(DEFAULT_POLL_DRAFT)
    expect(loadPollDraft(storage)).toEqual(DEFAULT_POLL_DRAFT)
    storage.setItem(POLL_DRAFT_STORAGE_KEY, '{not json')
    expect(loadPollDraft(storage)).toEqual(DEFAULT_POLL_DRAFT)
    storage.setItem(
      POLL_DRAFT_STORAGE_KEY,
      JSON.stringify({ question: 4, options: ['a', 7, 'b', 'c', 'd', 'e', 'f'], duration: '90' })
    )
    expect(loadPollDraft(storage)).toEqual({
      question: '',
      options: ['a', '', 'b', 'c', 'd'],
      duration: '60',
      postInChat: true
    })
    storage.setItem(POLL_DRAFT_STORAGE_KEY, JSON.stringify({ options: [] }))
    expect(loadPollDraft(storage).options).toEqual(['', ''])
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    } as unknown as Storage
    expect(loadPollDraft(throwing)).toEqual(DEFAULT_POLL_DRAFT)
    expect(() => savePollDraft(throwing, DEFAULT_POLL_DRAFT)).not.toThrow()
  })
})

describe('pollTallyView', () => {
  it('shows 0% and empty bars with no votes, never NaN', () => {
    const view = pollTallyView(poll(), OPENED_MS)
    expect(view.options.map((option) => [option.key, option.percentLabel, option.leading])).toEqual([
      ['1', '0%', false],
      ['2', '0%', false]
    ])
    expect(view.totalLabel).toBe('0 votes')
    expect(view.timeLabel).toBe('1:00 left')
    expect(view.canEnd).toBe(true)
    expect(view.canCancel).toBe(true)
    expect(view.headline).toBeNull()
    expect(view.platforms).toEqual([])
  })

  it('rounds percentages, marks the leader and splits votes by platform', () => {
    const view = pollTallyView(
      poll({
        options: [
          { label: 'Tabs', votes: 52 },
          { label: 'Spaces', votes: 32 }
        ],
        totalVotes: 84,
        winners: [0],
        byPlatform: [
          { platform: 'youtube', votes: 31 },
          { platform: 'twitch', votes: 53 },
          { platform: 'kick', votes: 0 }
        ]
      }),
      OPENED_MS + 18_200
    )
    expect(view.options.map((option) => [option.percentLabel, option.votes, option.leading])).toEqual(
      [
        ['62%', 52, true],
        ['38%', 32, false]
      ]
    )
    expect(view.totalLabel).toBe('84 votes')
    // Whole seconds left, rounded up.
    expect(view.timeLabel).toBe('0:42 left')
    expect(view.platforms).toEqual([
      { platform: 'youtube', label: 'YouTube', votes: 31 },
      { platform: 'twitch', label: 'Twitch', votes: 53 }
    ])
  })

  it('never counts below zero, says No timer, and Counting last votes… after the end', () => {
    expect(pollTallyView(poll(), OPENED_MS + 75_000).timeLabel).toBe('0:00 left')
    expect(pollTallyView(poll({ closesAt: undefined }), OPENED_MS).timeLabel).toBe('No timer')
    const counting = pollTallyView(poll({ state: 'counting' }), OPENED_MS + 61_000)
    expect(counting.timeLabel).toBe('Counting last votes…')
    expect(counting.canEnd).toBe(false)
    expect(counting.canCancel).toBe(true)
  })

  it('names the winner, a tie, or no votes once final', () => {
    const final = (options: PollStatus['options'], winners: number[]) =>
      pollTallyView(poll({ state: 'final', card: 'hidden', options, winners }), OPENED_MS)
    const won = final(
      [
        { label: 'Tabs', votes: 3 },
        { label: 'Spaces', votes: 1 }
      ],
      [0]
    )
    expect(won.headline).toBe('Tabs wins')
    expect(won.timeLabel).toBeNull()
    expect(won.canCancel).toBe(false)
    expect(won.canReshow).toBe(true)
    expect(
      final(
        [
          { label: 'Tabs', votes: 2 },
          { label: 'Spaces', votes: 2 },
          { label: 'Both', votes: 2 }
        ],
        [0, 1, 2]
      ).headline
    ).toBe('Tie: Tabs, Spaces, and Both')
    expect(
      final(
        [
          { label: 'Tabs', votes: 0 },
          { label: 'Spaces', votes: 0 }
        ],
        []
      ).headline
    ).toBe('No votes')
  })

  it('turns Show result again off while the result shows, or where no card can', () => {
    const shown = pollTallyView(poll({ state: 'final', card: 'shown' }), OPENED_MS)
    expect(shown.canReshow).toBe(false)
    expect(shown.reshowReason).toBe('The result is on stream now.')
    const noCard = pollTallyView(
      poll({ state: 'final', card: 'hidden', cardAvailable: false }),
      OPENED_MS
    )
    expect(noCard.canReshow).toBe(false)
    expect(noCard.reshowReason).toBe("The poll card can't show on this stream (4K 60 fps).")
  })

  it('says only what is true: paused chats, no card, failed posts, vertical viewers', () => {
    expect(pollTallyView(poll(), OPENED_MS).diagnostics).toEqual([])
    const troubled = pollTallyView(
      poll({
        pausedPlatforms: ['youtube'],
        cardAvailable: false,
        startPost: { phase: 'partial', failedPlatforms: ['youtube', 'x'] },
        resultPost: { phase: 'failed', failedPlatforms: ['x'] }
      }),
      OPENED_MS,
      { auxiliaryLeg: true }
    )
    expect(troubled.diagnostics).toEqual([
      "YouTube chat is paused, so YouTube votes aren't counting.",
      POLL_VERTICAL_CANT_VOTE,
      POLL_CARD_UNAVAILABLE,
      "Couldn't post to YouTube and X chat."
    ])
    // The window can't tell whether the session has a vertical leg: silent.
    expect(pollTallyView(poll(), OPENED_MS).diagnostics).not.toContain(POLL_VERTICAL_CANT_VOTE)
    expect(
      pollTallyView(poll({ cardLegs: { primary: true, auxiliary: true } }), OPENED_MS, {
        auxiliaryLeg: true
      }).diagnostics
    ).toEqual([])
    // Once final, only the post failures are still news.
    expect(
      pollTallyView(
        poll({
          state: 'final',
          pausedPlatforms: ['youtube'],
          resultPost: { phase: 'failed', failedPlatforms: ['youtube'] }
        }),
        OPENED_MS
      ).diagnostics
    ).toEqual(["Couldn't post to YouTube chat."])
  })
})

describe('folding votes out of the chat list (D5)', () => {
  const vote = (overrides: Partial<LiveChatMessage> = {}): LiveChatMessage => ({
    id: 's1:twitch:t:m1',
    providerMessageId: 'm1',
    platform: 'twitch',
    sessionId: 's1',
    authorName: 'Ada',
    authorBadges: [],
    authorRoles: [],
    publishedAt: '2026-10-22T12:00:30.000Z',
    receivedAt: '2026-10-22T12:00:31.000Z',
    messageText: '1',
    fragments: [],
    eventType: 'message',
    isDeleted: false,
    ...overrides
  })
  const at = (ms: number) => new Date(ms).toISOString()
  const ended = poll({
    state: 'final',
    endedAt: '2026-10-22T12:01:00.000Z',
    acceptUntil: '2026-10-22T12:01:15.000Z'
  })
  const window = pollFoldWindow(ended)!

  it('folds a vote inside the window, at both edges exactly', () => {
    expect(window).toEqual({
      pollId: 'poll-1',
      sessionId: 's1',
      fromMs: OPENED_MS - POLL_OPEN_SKEW_MS,
      untilMs: Date.parse('2026-10-22T12:01:15.000Z'),
      optionCount: 2
    })
    expect(pollFoldsMessage(vote(), window)).toBe(true)
    expect(pollFoldsMessage(vote({ publishedAt: at(OPENED_MS - 10_000) }), window)).toBe(true)
    expect(pollFoldsMessage(vote({ publishedAt: at(OPENED_MS - 10_001) }), window)).toBe(false)
    expect(pollFoldsMessage(vote({ publishedAt: '2026-10-22T12:01:15.000Z' }), window)).toBe(true)
    expect(pollFoldsMessage(vote({ publishedAt: '2026-10-22T12:01:15.001Z' }), window)).toBe(
      false
    )
  })

  it('folds every later vote while the poll has no end yet', () => {
    const open = pollFoldWindow(poll({ closesAt: undefined }))!
    expect(open.untilMs).toBeNull()
    expect(pollFoldsMessage(vote({ publishedAt: '2026-10-22T15:00:00.000Z' }), open)).toBe(true)
    // Ended with no grace (the session ended): the end is the edge.
    const sessionEnd = pollFoldWindow(poll({ state: 'final', endedAt: '2026-10-22T12:00:40Z' }))!
    expect(sessionEnd.untilMs).toBe(Date.parse('2026-10-22T12:00:40Z'))
  })

  it('keeps the streamer, paid messages, other text and wrong numbers in chat', () => {
    expect(pollFoldsMessage(vote({ authorRoles: ['owner'] }), window)).toBe(false)
    expect(pollFoldsMessage(vote({ authorRoles: ['moderator'] }), window)).toBe(true)
    expect(pollFoldsMessage(vote({ eventType: 'paid' }), window)).toBe(false)
    expect(pollFoldsMessage(vote({ messageText: '1 lol' }), window)).toBe(false)
    expect(pollFoldsMessage(vote({ messageText: ' 2️⃣ ' }), window)).toBe(true)
    // Two options: 3 is chat.
    expect(pollFoldsMessage(vote({ messageText: '3' }), window)).toBe(false)
    expect(pollFoldsMessage(vote({ sessionId: 's0' }), window)).toBe(false)
  })

  it('reads the platform time, and arrival only when that is missing', () => {
    expect(
      pollFoldsMessage(
        vote({ publishedAt: 'not a time', receivedAt: '2026-10-22T12:00:20.000Z' }),
        window
      )
    ).toBe(true)
    // A backlog page arrives inside the window but was typed before it.
    expect(
      pollFoldsMessage(
        vote({ publishedAt: '2026-10-22T11:59:00.000Z', receivedAt: '2026-10-22T12:00:20.000Z' }),
        window
      )
    ).toBe(false)
  })

  it('remembers a replaced poll, so its votes stay folded', () => {
    let windows = rememberPollWindows([], poll())
    windows = rememberPollWindows(windows, ended)
    expect(windows).toHaveLength(1)
    expect(windows[0].untilMs).not.toBeNull()
    const next = poll({
      pollId: 'poll-2',
      openedAt: '2026-10-22T12:10:00.000Z',
      options: [
        { label: 'a', votes: 0 },
        { label: 'b', votes: 0 },
        { label: 'c', votes: 0 }
      ]
    })
    windows = rememberPollWindows(windows, next)
    expect(rememberPollWindows(windows, null)).toBe(windows)
    const old = vote({ id: 'old' })
    const fresh = vote({ id: 'fresh', publishedAt: '2026-10-22T12:10:05.000Z', messageText: '3' })
    const chat = vote({ id: 'chat', messageText: 'hello' })
    expect([...foldedPollVoteIds([old, fresh, chat], windows)]).toEqual(['old', 'fresh'])
    expect(foldedPollVoteIds([old], []).size).toBe(0)
  })
})
