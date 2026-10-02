import { describe, expect, it } from 'vitest'

import { BackendRequestError } from '@/backendClient'
import {
  YOUTUBE_BROADCAST_NOT_FOUND_CODE,
  YOUTUBE_QUOTA_PAUSED_CODE,
  formatResumeTime,
  isSettledYouTubeCompletionError,
  isYouTubeQuotaPausedError,
  waitingProviderMessage,
  youtubeBroadcastToast,
  youtubeGoLivePausedMessage,
  youtubeQuotaPausedUntil
} from '@/lib/youtube-quota'

const localTime = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

describe('youtube quota copy (plan 094)', () => {
  it('reads the breaker end and ignores an absent or unreadable pause', () => {
    expect(youtubeQuotaPausedUntil({})).toBeNull()
    expect(youtubeQuotaPausedUntil(null)).toBeNull()
    expect(youtubeQuotaPausedUntil({ pausedUntil: 'garbage' })).toBeNull()
    expect(youtubeQuotaPausedUntil({ pausedUntil: '2026-10-03T07:00:00Z' })?.toISOString()).toBe(
      '2026-10-03T07:00:00.000Z'
    )
  })

  it('formats the resume time in local time, naming the day only when it is not today', () => {
    const now = new Date(2026, 9, 2, 20, 0, 0)
    const laterToday = new Date(2026, 9, 2, 23, 30, 0)
    expect(formatResumeTime(laterToday, now)).toBe(localTime(laterToday))
    const tomorrowMorning = new Date(2026, 9, 3, 9, 0, 0)
    expect(formatResumeTime(tomorrowMorning, now)).toBe(`tomorrow ${localTime(tomorrowMorning)}`)
    const nextWeek = new Date(2026, 9, 9, 9, 0, 0)
    expect(formatResumeTime(nextWeek, now)).toMatch(/^Oct 9 /)
    expect(formatResumeTime('garbage', now)).toBe('the reset')
  })

  it('appends the resume time to a parked YouTube chat provider', () => {
    const now = new Date(2026, 9, 2, 20, 0, 0)
    const retryAt = new Date(2026, 9, 2, 23, 0, 0)
    expect(
      waitingProviderMessage(
        {
          platform: 'youtube',
          state: 'waiting',
          message: "YouTube chat is paused: Videorc's daily YouTube API limit is used up.",
          retryAt: retryAt.toISOString()
        },
        now
      )
    ).toBe(
      `YouTube chat is paused: Videorc's daily YouTube API limit is used up. It resumes at ${localTime(retryAt)}. Your stream keeps going.`
    )
    // Without a known end, the provider's own words stand alone.
    expect(
      waitingProviderMessage({
        platform: 'kick',
        state: 'waiting',
        message: "Kick chat can't connect: Videorc's chat relay is down."
      })
    ).toBe("Kick chat can't connect: Videorc's chat relay is down.")
    expect(
      waitingProviderMessage({
        platform: 'youtube',
        state: 'connected',
        message: 'YouTube live chat connected.',
        retryAt: retryAt.toISOString()
      })
    ).toBe('YouTube live chat connected.')
  })

  it('names the destination only when its label is not the platform name', () => {
    const quota = 'YouTube ends the broadcast on its own about a minute after you stop.'
    expect(youtubeBroadcastToast('end', { label: 'YouTube', platform: 'youtube' }, quota)).toEqual({
      title: "Couldn't end the YouTube broadcast.",
      description: quota
    })
    expect(
      youtubeBroadcastToast('start', { label: 'YouTube (vertical)', platform: 'youtube' }, quota)
    ).toEqual({
      title: "Couldn't start the YouTube broadcast.",
      description: `YouTube (vertical): ${quota}`
    })
    expect(
      youtubeBroadcastToast('end', { label: '  youtube ', platform: 'youtube' }, quota).description
    ).toBe(quota)
  })

  it('treats quota and a missing broadcast as settled completions, nothing else', () => {
    expect(
      isSettledYouTubeCompletionError(new BackendRequestError(YOUTUBE_QUOTA_PAUSED_CODE, 'x'))
    ).toBe(true)
    expect(
      isSettledYouTubeCompletionError(
        new BackendRequestError(YOUTUBE_BROADCAST_NOT_FOUND_CODE, 'x')
      )
    ).toBe(true)
    expect(
      isSettledYouTubeCompletionError(
        new BackendRequestError('youtube-transition-failed', 'HTTP 503')
      )
    ).toBe(false)
    expect(isSettledYouTubeCompletionError(new Error('Backend socket is not connected.'))).toBe(
      false
    )
    expect(isYouTubeQuotaPausedError(new BackendRequestError(YOUTUBE_QUOTA_PAUSED_CODE, 'x'))).toBe(
      true
    )
    expect(
      isYouTubeQuotaPausedError(new BackendRequestError(YOUTUBE_BROADCAST_NOT_FOUND_CODE, 'x'))
    ).toBe(false)
  })

  it('words the Go Live refusal with the stream-key way out', () => {
    const now = new Date(2026, 9, 2, 20, 0, 0)
    const until = new Date(2026, 9, 2, 23, 0, 0)
    expect(youtubeGoLivePausedMessage(until, now)).toBe(
      `YouTube's API is paused until ${localTime(until)}, so Videorc can't create the YouTube broadcast. Go live on YouTube with your stream key instead.`
    )
  })
})
