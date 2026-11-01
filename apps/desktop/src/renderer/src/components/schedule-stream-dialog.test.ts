// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScheduledStreamEvent } from '@/lib/backend'
import type { useScheduledStreams } from '@/hooks/use-scheduled-streams'
import { scheduleBlockedReason, ScheduleStreamDialog } from './schedule-stream-dialog'
let root: Root
let container: HTMLDivElement
const event = {
  id: '11111111-1111-4111-8111-111111111111',
  revision: 1,
  accountId: 'channel',
  providerEventId: 'broadcast',
  watchUrl: 'https://youtube.com/watch?v=broadcast',
  requested: {
    title: 'Original title',
    description: '',
    privacy: 'private',
    madeForKids: false,
    localStart: '2035-01-01T12:00',
    timeZone: 'UTC',
    offsetChoice: null,
    thumbnailAssetId: null
  }
} as ScheduledStreamEvent
const latest = {
  ...event,
  revision: 2,
  requested: { ...event.requested, title: 'External edit', thumbnailAssetId: 'new-thumbnail' }
}
const request = vi.fn(async (method: string) =>
  method === 'resolveTime' ? { startUtc: '2035-01-01T12:00:00Z' } : method === 'get' ? latest : null
)
const mutate = vi.fn(async (): Promise<void> => {
  throw new Error('Revision changed')
})
const close = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
async function render(available = true) {
  const state = {
    request,
    mutate,
    capabilities: { available, accounts: [{ accountId: 'channel', accountLabel: 'Channel' }] }
  } as unknown as ReturnType<typeof useScheduledStreams>
  await act(async () => {
    root.render(createElement(ScheduleStreamDialog, { event, state, onClose: close }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 180))
  })
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith(label)
  )!
  expect(button).toBeTruthy()
  await act(async () => button.click())
}
async function title(value: string) {
  const input = document.querySelector<HTMLInputElement>('#schedule-title')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('scheduled form ownership', () => {
  it('preserves dirty input after a focus refresh conflict until explicit reload', async () => {
    await render()
    await title('My unsaved edit')
    await click('Update event')
    expect(document.querySelector<HTMLInputElement>('#schedule-title')!.value).toBe(
      'My unsaved edit'
    )
    expect(mutate).toHaveBeenCalledTimes(1)
    await click('Update event')
    expect(mutate).toHaveBeenCalledTimes(1)
    mutate.mockResolvedValueOnce(undefined)
    await click('Reload latest changes')
    expect(document.querySelector<HTMLInputElement>('#schedule-title')!.value).toBe('External edit')
  })
  it('searches IANA zones and keeps picker cancellation free of edits', async () => {
    Object.defineProperty(window, 'videorc', {
      configurable: true,
      value: { importScheduledThumbnail: vi.fn(async () => null) }
    })
    await render()
    await click('Choose thumbnail')
    expect(document.querySelector('img[alt="Upcoming stream thumbnail"]')).toBeNull()
    await click('UTC')
    const search = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search time zones…"]'
    )!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        search,
        'Madrid'
      )
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const option = [...document.querySelectorAll('[cmdk-item]')].find(
      // Zones read as a city and its offset at the event's time (plan 174 S3.5b, D-31).
      (item) => item.textContent === 'Madrid (GMT+1)'
    ) as HTMLElement
    expect(option).toBeTruthy()
    await act(async () => option.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180))
    })
    expect(request).toHaveBeenCalledWith(
      'resolveTime',
      expect.objectContaining({ timeZone: 'Europe/Madrid' })
    )
  })
  it('requires dirty dismissal confirmation and honors unavailable keyboard publishing', async () => {
    await render(false)
    await title('Unsaved')
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    )
    expect(mutate).not.toHaveBeenCalled()
    await click('Cancel')
    expect(close).not.toHaveBeenCalled()
    await click('Keep editing')
    expect(close).not.toHaveBeenCalled()
    await click('Cancel')
    await click('Discard')
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('opens each platform with its own fields: X plans an end, YouTube sets visibility', async () => {
    const account = (accountId: string) => ({ accountId, accountLabel: accountId })
    const state = {
      request,
      mutate,
      capabilities: {
        available: true,
        accounts: [],
        providers: [
          { provider: 'youtube', available: true, reason: null, accounts: [account('channel')] },
          { provider: 'x', available: true, reason: null, accounts: [account('x-account')] }
        ]
      }
    } as unknown as ReturnType<typeof useScheduledStreams>
    const open = async (provider: 'youtube' | 'x') => {
      await act(async () => {
        root.render(
          createElement(ScheduleStreamDialog, {
            key: provider,
            event: null,
            provider,
            state,
            onClose: close
          })
        )
      })
    }
    await open('x')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Schedule on X')
    expect(document.querySelector<HTMLInputElement>('#schedule-end')?.value).not.toBe('')
    expect(document.querySelector('#schedule-replay')).not.toBeNull()
    expect(document.querySelector('#schedule-privacy')).toBeNull()
    expect(document.querySelector('#schedule-audience')).toBeNull()
    await open('youtube')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Schedule on YouTube')
    expect(document.querySelector('#schedule-end')).toBeNull()
    expect(document.querySelector('#schedule-replay')).toBeNull()
    expect(document.querySelector('#schedule-privacy')).not.toBeNull()
    expect(document.querySelector('#schedule-audience')).not.toBeNull()
  })
})

describe('schedule form reasons (plan 174 S3.5b)', () => {
  const ready = {
    provider: 'youtube' as const,
    accountId: 'channel',
    title: 'Friday build',
    description: '',
    audience: 'false',
    plannedEndError: '',
    timeError: '',
    resolving: false
  }

  it('says why the form cannot be sent, one reason in field order (D-11)', () => {
    expect(scheduleBlockedReason(ready)).toBeNull()
    expect(scheduleBlockedReason({ ...ready, accountId: '' })).toBe('Choose a YouTube channel.')
    expect(scheduleBlockedReason({ ...ready, provider: 'x', accountId: '' })).toBe(
      'Choose an X account.'
    )
    expect(scheduleBlockedReason({ ...ready, title: ' ' })).toBe('Add a title.')
    expect(scheduleBlockedReason({ ...ready, title: 'a<b' })).toBe("Titles can't contain < or >.")
    expect(scheduleBlockedReason({ ...ready, audience: '' })).toBe(
      "Choose whether it's made for kids."
    )
    expect(scheduleBlockedReason({ ...ready, provider: 'x', audience: '' })).toBeNull()
    expect(
      scheduleBlockedReason({ ...ready, timeError: 'Enter a valid local date and time.' })
    ).toBe('Enter a valid local date and time.')
  })

  it('asks which offset only when the clocks repeat the time (D-31)', async () => {
    await render()
    expect(document.querySelector('#schedule-offset')).toBeNull()
    expect(document.querySelector('[data-testid="schedule-start-summary"]')?.textContent).toMatch(
      /2035/
    )
    const repeated = {
      ...event,
      requested: { ...event.requested, localStart: '2026-10-25T02:30', timeZone: 'Europe/Madrid' }
    } as ScheduledStreamEvent
    const state = {
      request,
      mutate,
      capabilities: {
        available: true,
        accounts: [{ accountId: 'channel', accountLabel: 'Channel' }]
      }
    } as unknown as ReturnType<typeof useScheduledStreams>
    await act(async () => {
      root.render(
        createElement(ScheduleStreamDialog, {
          key: 'repeat',
          event: repeated,
          state,
          onClose: close
        })
      )
    })
    expect(document.querySelector('#schedule-offset')).not.toBeNull()
    expect(document.body.textContent).toContain('This time happens twice')
  })

  it('explains an empty channel list and links to Setup', async () => {
    const state = {
      request,
      mutate,
      capabilities: {
        available: true,
        accounts: [],
        providers: [{ provider: 'youtube', available: true, reason: null, accounts: [] }]
      }
    } as unknown as ReturnType<typeof useScheduledStreams>
    await act(async () => {
      root.render(
        createElement(ScheduleStreamDialog, {
          event: null,
          provider: 'youtube',
          state,
          onClose: close
        })
      )
    })
    expect(document.body.textContent).toContain('Sign in to YouTube in Livestream → Setup first.')
    expect(
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Open Setup')
    ).toBe(true)
  })
})
