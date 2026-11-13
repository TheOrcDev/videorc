// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudRoomGuest, CloudStageLayout, CloudStatus } from '@/lib/backend'
import { HOST, ada, grace, openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import { NO_TALK_SHOW, type TalkShowContextValue } from '@/lib/talk-show-context'
import { planStage } from '@/lib/talk-show-layout'

import ShowStage from './show-stage'

// Plan 224 C-G3: the Show stage draws every layout for 1 to 6 people with
// the runner's geometry, and the backstage strip's moves reach the room with
// the right identities and guest ids.

const studio = vi.hoisted(() => ({
  cloud: { cloudStatus: null as CloudStatus | null, talkShow: null as unknown }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud
}))

function talkShow(overrides: Partial<TalkShowContextValue> = {}): TalkShowContextValue {
  return {
    ...NO_TALK_SHOW,
    hostIdentity: HOST,
    previewReplaced: true,
    closeRoom: vi.fn(async () => {}),
    decideGuest: vi.fn(async () => {}),
    actOnGuest: vi.fn(async () => {}),
    bringOn: vi.fn(async () => {}),
    sendBackstage: vi.fn(async () => {}),
    setLayout: vi.fn(async () => {}),
    setSpotlight: vi.fn(async () => {}),
    setMicrophoneMuted: vi.fn(async () => {}),
    setMonitor: vi.fn(async () => {}),
    ...overrides
  }
}

function guestsFor(count: number): CloudRoomGuest[] {
  return Array.from({ length: count }, (_, index) => ({
    guestId: `g_${index + 1}`,
    name: `Guest ${index + 1}`,
    joinedAt: `2026-11-09T10:0${index}:00Z`,
    muted: false,
    screenShareAllowed: false
  }))
}

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
  await act(async () => root.render(createElement(TooltipProvider, null, createElement(ShowStage))))
}

const LAYOUTS: CloudStageLayout[] = ['solo', 'side-by-side', 'screen-people', 'spotlight']

describe('the stage (D8)', () => {
  it.each(LAYOUTS.flatMap((layout) => [1, 2, 3, 4, 5, 6].map((n) => [layout, n] as const)))(
    'draws %s with %i on stage where the runner puts them',
    async (layout, n) => {
      const guests = guestsFor(n - 1)
      const onStage = [HOST, ...guests.map((guest) => guest.guestId)]
      const stage = {
        layout,
        onStage,
        ...(layout === 'screen-people' ? { screen: HOST } : {}),
        ...(layout === 'spotlight' && n > 1 ? { spotlight: 'g_1' } : {})
      }
      await mount(talkStatus({ room: openRoom({ guests, stage }) }), talkShow())
      const tiles = [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-tile"]')]
      const plan = planStage(
        { width: 1920, height: 1080 },
        { layout, people: onStage, screen: stage.screen, spotlight: stage.spotlight }
      )
      expect(tiles).toHaveLength(plan.tiles.length)
      tiles.forEach((tile, index) => {
        const expected = plan.tiles[index]
        expect(tile.dataset.stageIdentity).toBe(expected.identity)
        expect(tile.style.left).toBe(`${(expected.rect.x / 1920) * 100}%`)
        expect(tile.style.width).toBe(`${(expected.rect.w / 1920) * 100}%`)
      })
    }
  )

  it('draws the stage as the program does: no re-flowed guest, no stale screen (review M2)', async () => {
    const participant = (identity: string) => ({
      identity,
      name: identity,
      role: identity === HOST ? ('host' as const) : ('guest' as const),
      onStage: true,
      video: true,
      audio: true,
      muted: false,
      screen: false,
      quality: 'good' as const,
      sinceMs: 1000,
      away: false
    })
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          participants: [participant(HOST), participant('g_ada'), participant('g_grace')],
          stage: { layout: 'screen-people', onStage: [HOST, 'g_ada', 'g_grace'], screen: 'g_ada' },
          shown: { onStage: [HOST, 'g_ada'] }
        })
      }),
      talkShow()
    )
    const tiles = [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-tile"]')]
    expect(tiles.map((tile) => tile.dataset.stageIdentity)).toEqual([HOST, 'g_ada'])
    expect(tiles.every((tile) => tile.dataset.stageKind === 'person')).toBe(true)
    const checked = container.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
    expect(checked?.textContent).toBe('Side by side')
  })

  it('says so when nobody is on stage, and keeps the Preview line for the lifecycle probe', async () => {
    await mount(
      talkStatus({ room: openRoom({ stage: { layout: 'solo', onStage: [] } }) }),
      talkShow()
    )
    expect(container.textContent).toContain('Nobody is on stage.')
    expect(container.querySelector('[data-testid="preview-replaced-by-show-stage"]')).not.toBeNull()
  })

  it('subscribes the Program monitor once the room is joined, and lets go after', async () => {
    const show = talkShow({ room: { ...NO_TALK_SHOW.room, state: 'connected' } })
    await mount(talkStatus({ room: openRoom() }), show)
    expect(show.setMonitor).toHaveBeenCalledWith(true)
    await act(async () => root.render(createElement('div')))
    expect(show.setMonitor).toHaveBeenLastCalledWith(false)
  })
})

describe('the backstage strip (C-G3)', () => {
  const row = (name: string): HTMLElement =>
    [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-strip-row"]')].find(
      (element) => element.querySelector('[data-slot="list-row-title"]')?.textContent === name
    ) as HTMLElement

  const button = (element: HTMLElement, label: string): HTMLButtonElement =>
    [...element.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === label
    ) as HTMLButtonElement

  it('brings a backstage guest on and sends an on-stage one back, by identity', async () => {
    const show = talkShow()
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] }
        })
      }),
      show
    )
    await act(async () => button(row('Ada'), 'Bring on').click())
    await act(async () => button(row('Grace'), 'Send backstage').click())
    expect(show.bringOn).toHaveBeenCalledWith('g_ada')
    expect(show.sendBackstage).toHaveBeenCalledWith('g_grace')
  })

  it('never offers to send the host backstage (review L3)', async () => {
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'] }
        })
      }),
      talkShow()
    )
    const host = row('You')
    expect(host.querySelector('[data-testid="show-stage-send-backstage"]')).toBeNull()
    expect(host.querySelector('[data-testid="show-stage-bring-on"]')).toBeNull()
    expect(button(host, 'Mute')).toBeDefined()
    expect(row('Ada').querySelector('[data-testid="show-stage-send-backstage"]')).not.toBeNull()
  })

  it("holds a guest's mic by guest id, and mutes the host's own mic locally", async () => {
    const show = talkShow()
    await mount(talkStatus({ room: openRoom({ guests: [ada, grace] }) }), show)
    await act(async () => button(row('Ada'), 'Mute').click())
    await act(async () => button(row('Grace'), 'Unmute').click())
    await act(async () => button(row('You'), 'Mute').click())
    expect(show.actOnGuest).toHaveBeenCalledWith('g_ada', 'mute', undefined)
    expect(show.actOnGuest).toHaveBeenCalledWith('g_grace', 'unmute', undefined)
    expect(show.setMicrophoneMuted).toHaveBeenCalledWith(true)
  })

  it("holds Bring on with Premium's one seat taken", async () => {
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] },
          limits: { guestsOnStage: 1, roomSize: 3, recordingRetentionDays: 7 }
        })
      }),
      talkShow()
    )
    expect(button(row('Ada'), 'Bring on').disabled).toBe(true)
    expect(container.innerHTML).toContain('Up to 1 guest on stage with Premium.')
  })

  it('lets a request in from above the strip by its request id', async () => {
    const show = talkShow()
    await mount(
      talkStatus({
        room: openRoom({
          requests: [
            { requestId: 'r9', name: 'Linus', askedAt: '2026-11-09T10:02:00Z', device: 'phone' }
          ]
        })
      }),
      show
    )
    const alert = container.querySelector<HTMLElement>('[data-testid="show-stage-request"]')
    expect(alert?.textContent).toContain('Linus wants to join')
    await act(async () => button(alert as HTMLElement, 'Let in').click())
    expect(show.decideGuest).toHaveBeenCalledWith('r9', 'let-in')
  })

  it('changes the layout through the chips, and waits on a screen for Screen + people', async () => {
    const show = talkShow()
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'] }
        })
      }),
      show
    )
    const chip = (label: string): HTMLButtonElement =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (candidate) => candidate.textContent === label
      ) as HTMLButtonElement
    await act(async () => chip('Spotlight').click())
    expect(show.setLayout).toHaveBeenCalledWith('spotlight')
    expect(chip('Screen + people').disabled).toBe(true)
    expect(container.textContent).toContain('Share a screen first for Screen + people.')
  })
})
