// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudStatus } from '@/lib/backend'
import { defaultCaptureConfig } from '@/lib/capture'
import { HOST, ada, grace, openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import { NO_TALK_SHOW, type TalkShowContextValue } from '@/lib/talk-show-context'

import GuestsTab from './guests-tab'

// Plan 224 C-G2: Destinations → Guests renders locked, empty, a request, two
// guests and a full room, and its buttons reach the room's actions.

const studio = vi.hoisted(() => ({
  cloud: { cloudStatus: null as CloudStatus | null, talkShow: null as unknown },
  core: {
    captureConfig: {
      streaming: {
        targets: [
          { platform: 'youtube', enabled: true },
          { platform: 'twitch', enabled: false }
        ]
      }
    },
    streamMetadataDraft: { title: '  Orc talk  ' },
    isSessionActive: false,
    wsStatus: 'connected'
  }
}))

// Plan 249 S17: the tab now says what the room will send, from the canvas.
Object.assign(studio.core.captureConfig, {
  video: defaultCaptureConfig.video,
  recordEnabled: false
})

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud,
  useStudioCore: () => studio.core,
  // Plan 249 S22: the Separate files section asks the backend through it.
  useStudioDiagnostics: () => ({ client: null })
}))

function talkShow(overrides: Partial<TalkShowContextValue> = {}): TalkShowContextValue {
  return {
    ...NO_TALK_SHOW,
    hostIdentity: HOST,
    openRoom: vi.fn(async () => {}),
    closeRoom: vi.fn(async () => {}),
    rotateInvite: vi.fn(async () => {}),
    setDoor: vi.fn(async () => {}),
    decideGuest: vi.fn(async () => {}),
    actOnGuest: vi.fn(async () => {}),
    ...overrides
  }
}

function html(status: CloudStatus | null): string {
  studio.cloud.cloudStatus = status
  studio.cloud.talkShow = talkShow()
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(GuestsTab)))
}

describe('Destinations → Guests (C-G2)', () => {
  it('locks behind Premium for a Basic account, every control off', () => {
    const page = html(talkStatus({ entitled: false, plan: undefined }))
    expect(page).toContain('Talk shows with guests come with Videorc Premium.')
    expect(page).toContain('View Premium')
    expect(page).toMatch(/data-testid="guests-open-room"[^>]*disabled/)
  })

  it('opens an empty room: the link, the door off, nobody yet', () => {
    const page = html(talkStatus({ room: openRoom() }))
    expect(page).toContain('Room open')
    expect(page).toContain('Close the room')
    expect(page).toContain('https://videorc.com/guest/k7m2Ab9xQp3rT5vW')
    expect(page).toContain('Let anyone with the link in backstage')
    expect(page).toContain('Nobody has joined yet. Share the link.')
    expect(page).toContain('Up to 5 guests on stage, 10 people in the room.')
    expect(page).toContain('This show goes out live on YouTube and Twitch and may be recorded.')
  })

  it('leads the list with a request, Let in and Decline', () => {
    const page = html(
      talkStatus({
        room: openRoom({
          requests: [
            { requestId: 'r1', name: 'Linus', askedAt: '2026-11-09T10:02:00Z', device: 'phone' }
          ],
          declinedCount: 2
        })
      })
    )
    expect(page).toContain('Linus wants to join')
    expect(page).toContain('On a phone')
    expect(page).toContain('Let in')
    expect(page).toContain('Decline')
    expect(page).toContain('2 more asked')
  })

  it('lists two guests, on stage and backstage, with the host first', () => {
    const page = html(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] }
        })
      })
    )
    const names = [...page.matchAll(/data-slot="list-row-title">([^<]+)</g)].map((m) => m[1])
    expect(names).toEqual(['You', 'Grace', 'Ada'])
    expect(page).toContain('On stage')
    expect(page).toContain('Backstage')
    expect(page).toContain('Muted')
    expect(page).toContain('Actions for Grace')
    expect(page).not.toContain('Actions for You')
  })

  it("says a full room is full, and Premium's one seat", () => {
    const page = html(
      talkStatus({
        plan: 'premium',
        room: openRoom({
          guests: [ada],
          limits: { guestsOnStage: 1, roomSize: 2, recordingRetentionDays: 7 }
        })
      })
    )
    expect(page).toContain('The room is full.')
    expect(page).toContain('Up to 1 guest on stage with Premium. Videorc Max seats 5.')
  })
})

describe('Guests tab actions', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function mount(status: CloudStatus, show: TalkShowContextValue): Promise<void> {
    studio.cloud.cloudStatus = status
    studio.cloud.talkShow = show
    await act(async () =>
      root.render(createElement(TooltipProvider, null, createElement(GuestsTab)))
    )
  }

  const click = async (selector: string): Promise<void> => {
    const element = container.querySelector<HTMLElement>(selector)
    expect(element).not.toBeNull()
    await act(async () => element?.click())
  }

  it('opens the room with the stream title and the enabled platforms', async () => {
    const show = talkShow()
    await mount(talkStatus(), show)
    await click('[data-testid="guests-open-room"]')
    expect(show.openRoom).toHaveBeenCalledWith({ title: 'Orc talk', platforms: ['youtube'] })
  })

  it('lets a guest in and declines another by their request ids', async () => {
    const show = talkShow()
    await mount(
      talkStatus({
        room: openRoom({
          requests: [
            { requestId: 'r1', name: 'Linus', askedAt: '2026-11-09T10:02:00Z', device: 'phone' },
            { requestId: 'r2', name: 'Ken', askedAt: '2026-11-09T10:03:00Z', device: 'computer' }
          ]
        })
      }),
      show
    )
    const rows = [...container.querySelectorAll('[data-testid="guests-request"]')]
    await act(async () =>
      [...rows[0].querySelectorAll('button')].find((b) => b.textContent === 'Let in')?.click()
    )
    await act(async () =>
      [...rows[1].querySelectorAll('button')].find((b) => b.textContent === 'Decline')?.click()
    )
    expect(show.decideGuest).toHaveBeenCalledWith('r1', 'let-in')
    expect(show.decideGuest).toHaveBeenCalledWith('r2', 'decline')
  })

  it('makes a new link at once in an empty room, and asks first with guests in it', async () => {
    const show = talkShow()
    await mount(talkStatus({ room: openRoom() }), show)
    await click('[data-testid="guests-invite-rotate"]')
    expect(show.rotateInvite).toHaveBeenCalledTimes(1)

    const withGuests = talkShow()
    await mount(talkStatus({ room: openRoom({ guests: [ada] }) }), withGuests)
    await click('[data-testid="guests-invite-rotate"]')
    expect(withGuests.rotateInvite).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Everyone keeps their place.')
  })
})

// The owner, 2026-11-18 (0.31.1): the room's avatar and graphics are switches
// beside the Door, their one home; the Show stage only links here.
describe('Guests → Room: on the program (plan 249 S4/S9)', () => {
  let root: Root
  let container: HTMLDivElement
  const managedShow = { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' as const }
  const avatar = (
    enabled: boolean,
    guests: { enabled: boolean; capable: number; applied: number },
    state: 'preview' | 'applied' = 'preview'
  ) => ({
    enabled,
    state,
    reason: null,
    revision: 1,
    preview: null,
    observed: {},
    guests,
    productionQualified: false as const
  })

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  async function mount(status: CloudStatus, show: TalkShowContextValue): Promise<void> {
    studio.cloud.cloudStatus = status
    studio.cloud.talkShow = show
    await act(async () =>
      root.render(createElement(TooltipProvider, null, createElement(GuestsTab)))
    )
  }
  const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const toggle = (id: string) => row(id)?.querySelector<HTMLElement>('[role="switch"]') ?? null

  it('is only for a managed show', async () => {
    await mount(talkStatus({ room: openRoom() }), talkShow())
    expect(row('guests-program')).toBeNull()
  })

  it('turns the avatar and the graphics on for this room, off until then', async () => {
    const setAvatarEnabled = vi.fn(async () => {})
    const setGraphicsEnabled = vi.fn(async () => {})
    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({ setAvatarEnabled, setGraphicsEnabled })
    )
    expect(row('guests-program')?.textContent).toContain('On the program')
    expect(row('guests-program-avatar')?.textContent).toContain('Not on the stream.')
    expect(row('guests-program-graphics')?.textContent).toContain(
      'Banners, timers and the chat box. Not on the stream.'
    )
    expect(toggle('guests-program-avatar')?.getAttribute('aria-checked')).toBe('false')
    // Guests see the avatar only once it is on.
    expect(row('guests-program-avatar-guests')).toBeNull()
    await act(async () => toggle('guests-program-avatar')?.click())
    await act(async () => toggle('guests-program-graphics')?.click())
    expect(setAvatarEnabled).toHaveBeenCalledWith(true)
    expect(setGraphicsEnabled).toHaveBeenCalledWith(true)
  })

  it('offers guests the avatar once it is on, and says how many confirmed', async () => {
    const setAvatarGuests = vi.fn(async () => {})
    const status = talkStatus({ show: managedShow, room: openRoom({ live: true }) })
    await mount(
      status,
      talkShow({
        setAvatarGuests,
        room: {
          ...NO_TALK_SHOW.room,
          avatar: avatar(true, { enabled: false, capable: 2, applied: 0 })
        }
      })
    )
    expect(row('guests-program-avatar')?.textContent).toContain(
      'On. Waiting for the stream to confirm.'
    )
    expect(row('guests-program-avatar-guests')?.textContent).toContain(
      "Guests don't see the avatar"
    )
    await act(async () => toggle('guests-program-avatar-guests')?.click())
    expect(setAvatarGuests).toHaveBeenCalledWith(true)

    await mount(
      status,
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          avatar: avatar(true, { enabled: true, capable: 3, applied: 2 }, 'applied')
        }
      })
    )
    expect(row('guests-program-avatar')?.textContent).toContain('On the stream and the recording.')
    expect(row('guests-program-avatar-guests')?.textContent).toContain(
      'Shown to guests · 2 of 3 confirmed'
    )
    expect(toggle('guests-program-avatar-guests')?.getAttribute('aria-checked')).toBe('true')
  })

  it('says why when the stream refused the avatar', async () => {
    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          avatar: {
            ...avatar(true, { enabled: false, capable: 0, applied: 0 }),
            state: 'failed',
            reason: 'The stream refused the avatar.'
          }
        }
      })
    )
    expect(row('guests-program-avatar')?.textContent).toContain('The stream refused the avatar.')
  })
})
