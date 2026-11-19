// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudRoomGuest, CloudStageLayout, CloudStatus, StreamScreen } from '@/lib/backend'
import {
  HOST,
  ada,
  grace,
  guestParticipant,
  openRoom,
  talkStatus
} from '@/lib/guests-room-fixtures'
import { NO_TALK_SHOW, type TalkShowContextValue } from '@/lib/talk-show-context'
import { planStage } from '@/lib/talk-show-layout'
import { toast } from '@/lib/toast'

import ShowStage from './show-stage'

// Plan 224 C-G3: the Show stage draws every layout for 1 to 6 people with
// the runner's geometry, and the backstage strip's moves reach the room with
// the right identities and guest ids.

const studio = vi.hoisted(() => ({
  cloud: { cloudStatus: null as CloudStatus | null, talkShow: null as unknown },
  core: { activeScreen: null as StreamScreen | null }
}))

vi.mock('@/hooks/use-studio', () => ({
  useStudioCloud: () => studio.cloud,
  useStudioCore: () => studio.core
}))

const navigation = vi.hoisted(() => ({ open: (_view: string): void => {} }))
vi.mock('@/lib/workspace-navigation', () => ({
  openWorkspaceTab: (tab: string) => navigation.open(tab)
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
  studio.core.activeScreen = null
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
    const checked = container.querySelector<HTMLElement>(
      '[data-testid="show-stage-layout"][data-selected]'
    )
    expect(checked?.dataset.stageLayout).toBe('side-by-side')
    expect(checked?.querySelector('button')?.getAttribute('aria-pressed')).toBe('true')
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

// Plan 247 D-2: the stream clips the host's camera to a circle when the
// stage says `hostShape: 'circle'` (the program page's rule, never in
// Solo); the Show stage and the Program monitor copy it, and the name plate
// stays outside the clip.
describe("the host's circle (plan 247 D-2)", () => {
  const tiles = (root: ParentNode = container) => [
    ...root.querySelectorAll<HTMLElement>('[data-testid="show-stage-tile"]')
  ]
  const tileOf = (identity: string, root?: ParentNode) =>
    tiles(root).find((tile) => tile.dataset.stageIdentity === identity) as HTMLElement

  it('clips the host side by side to a circle, never a guest, and keeps the plate', async () => {
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'], hostShape: 'circle' }
        })
      }),
      talkShow()
    )
    const host = tileOf(HOST)
    expect(host.dataset.stageShape).toBe('circle')
    expect(host.style.clipPath).toBe('circle(closest-side at 50% 50%)')
    expect(host.style.borderRadius).toMatch(/^0(px)?$/)
    const guest = tileOf('g_ada')
    expect(guest.dataset.stageShape).toBe('rounded')
    expect(guest.style.clipPath).toBe('')
    // The plate sits beside the tile, as on the program page, so the clip
    // never cuts it.
    const plates = [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-plate"]')]
    expect(plates.map((plate) => plate.textContent)).toContain('You')
    expect(host.querySelector('[data-testid="show-stage-plate"]')).toBeNull()
  })

  it('keeps Solo square to the frame and a rounded host rounded', async () => {
    await mount(
      talkStatus({
        room: openRoom({ stage: { layout: 'solo', onStage: [HOST], hostShape: 'circle' } })
      }),
      talkShow()
    )
    expect(tileOf(HOST).dataset.stageShape).toBe('rounded')
    expect(tileOf(HOST).style.clipPath).toBe('')
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'], hostShape: 'rounded' }
        })
      }),
      talkShow()
    )
    expect(tileOf(HOST).dataset.stageShape).toBe('rounded')
  })

  it('draws the same circle in the Program monitor of a managed show', async () => {
    const managedShow = {
      id: 'sh_talk',
      nodeId: 'livekit',
      resumable: false,
      kind: 'talk' as const
    }
    await mount(
      talkStatus({
        show: managedShow,
        room: openRoom({
          live: true,
          guests: [ada],
          participants: [HOST, 'g_ada'].map((identity) => ({
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
          })),
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada'], hostShape: 'circle' },
          shown: { onStage: [HOST, 'g_ada'] }
        })
      }),
      talkShow()
    )
    const monitor = container.querySelector<HTMLElement>('[data-testid="show-stage-program"]')
    expect(tileOf(HOST, monitor as HTMLElement).dataset.stageShape).toBe('circle')
    expect(tileOf('g_ada', monitor as HTMLElement).dataset.stageShape).toBe('rounded')
  })
})

// Plan 210 D8 in a room (owner, 2026-11-19): a hidden screen shows its
// frosted still, as in the Studio and as guests and the program draw it,
// never the guarded track's flat grey. In the room view and the Program
// preview alike, fitted as the screen is.
describe('a hidden screen (plan 210 D8)', () => {
  const STILL = 'data:image/png;base64,c3RpbGw='
  const managedShow = { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' as const }
  const hidden = () =>
    talkShow({
      room: {
        ...NO_TALK_SHOW.room,
        local: { ...NO_TALK_SHOW.room.local, screenStill: STILL }
      }
    })
  const room = () =>
    openRoom({
      live: true,
      stage: { layout: 'screen-people', onStage: [HOST], screen: HOST },
      shown: { onStage: [HOST], screen: HOST }
    })
  const stills = () => [
    ...container.querySelectorAll<HTMLImageElement>('[data-testid="show-stage-screen-still"]')
  ]

  it('draws the frosted still over the host screen in the room and the Program preview', async () => {
    await mount(talkStatus({ show: managedShow, room: room() }), hidden())
    const well = container.querySelector<HTMLElement>('[data-testid="show-stage-well"]')
    const program = container.querySelector<HTMLElement>('[data-testid="show-stage-program"]')
    expect(stills()).toHaveLength(2)
    for (const still of stills()) {
      expect(still.getAttribute('src')).toBe(STILL)
      expect(still.closest('[data-stage-kind]')?.getAttribute('data-stage-kind')).toBe('screen')
    }
    const roomStill = well?.querySelector<HTMLImageElement>(
      '[data-testid="show-stage-screen-still"]'
    )
    expect(roomStill?.className).toContain('object-contain')
    expect(program?.querySelector('[data-testid="show-stage-screen-still"]')).not.toBeNull()
    // The still is the picture: no waiting words under it.
    expect(well?.textContent).not.toContain('Waiting for the screen')
  })

  it('draws nothing over a visible screen', async () => {
    await mount(talkStatus({ show: managedShow, room: room() }), talkShow())
    expect(stills()).toHaveLength(0)
    expect(container.querySelector('[data-testid="show-stage-well"]')?.textContent).toContain(
      'Waiting for the screen'
    )
  })
})

// Plan 234 D6 (T3): a managed show has no return picture. The Program
// monitor keeps its frame, its label and its two waiting lines, and draws
// the Show stage as the program page reports it. Nothing asks for a return.
describe('the Program monitor on a managed show (plan 234 D6)', () => {
  const managedShow = { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' as const }
  const nodeShow = { id: 'sh_talk', nodeId: 'eu-hel-1', resumable: false, kind: 'talk' as const }
  const monitor = () => container.querySelector<HTMLElement>('[data-testid="show-stage-program"]')
  const monitorTiles = () => [
    ...(monitor()?.querySelectorAll<HTMLElement>('[data-testid="show-stage-tile"]') ?? [])
  ]
  const speaker = () =>
    monitor()?.querySelector('button[aria-label="Listen to the program"]') ?? null

  it("shows a node show's return, with its speaker, and asks for it", async () => {
    const show = talkShow({ room: { ...NO_TALK_SHOW.room, state: 'connected' } })
    await mount(talkStatus({ show: nodeShow, room: openRoom({ live: true }) }), show)
    expect(monitor()?.dataset.programSource).toBe('return')
    expect(speaker()).not.toBeNull()
    expect(monitorTiles()).toHaveLength(0)
    expect(monitor()?.textContent).toContain('Waiting for the program…')
    expect(show.setMonitor).toHaveBeenCalledWith(true)
  })

  it('keeps the frame and the empty line before the show starts, with no speaker', async () => {
    const show = talkShow({ room: { ...NO_TALK_SHOW.room, state: 'connected' } })
    await mount(talkStatus({ show: managedShow, room: openRoom() }), show)
    expect(monitor()?.dataset.programSource).toBe('stage')
    expect(monitor()?.textContent).toContain('Program')
    expect(monitor()?.textContent).toContain('Program appears when the show starts.')
    expect(speaker()).toBeNull()
    expect(monitor()?.querySelector('audio')).toBeNull()
    expect(monitorTiles()).toHaveLength(0)
    // No return exists to subscribe to or to ask the backend for.
    expect(show.setMonitor).not.toHaveBeenCalled()
  })

  it('waits for the program page once the show runs', async () => {
    await mount(talkStatus({ show: managedShow, room: openRoom({ live: true }) }), talkShow())
    expect(monitor()?.textContent).toContain('Waiting for the program…')
    expect(monitorTiles()).toHaveLength(0)
    // A cloud recording alone runs the program too.
    await mount(
      talkStatus({
        show: managedShow,
        room: openRoom(),
        recording: { active: true, seconds: 3, bytes: 0, orientations: ['horizontal'] }
      }),
      talkShow()
    )
    expect(monitor()?.textContent).toContain('Waiting for the program…')
  })

  it('draws the stage the program page reports, with the same geometry and no words', async () => {
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
        show: managedShow,
        room: openRoom({
          live: true,
          guests: [ada, grace],
          participants: [participant(HOST), participant('g_ada'), participant('g_grace')],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada', 'g_grace'] },
          // The page dropped Grace from the layout (her camera stopped).
          shown: { onStage: [HOST, 'g_ada'] }
        })
      }),
      talkShow()
    )
    const tiles = monitorTiles()
    const plan = planStage(
      { width: 1920, height: 1080 },
      { layout: 'side-by-side', people: [HOST, 'g_ada'], screen: null, spotlight: null }
    )
    expect(tiles.map((tile) => tile.dataset.stageIdentity)).toEqual([HOST, 'g_ada'])
    tiles.forEach((tile, index) => {
      expect(tile.style.left).toBe(`${(plan.tiles[index].rect.x / 1920) * 100}%`)
      expect(tile.style.width).toBe(`${(plan.tiles[index].rect.w / 1920) * 100}%`)
    })
    // The picture only: no name plate and no placeholder words in the small frame.
    expect(monitor()?.textContent).toContain('Program preview')
    // The room's opt-ins are summed up in one line that opens Guests → Room.
    expect(
      monitor()?.querySelector('[data-testid="show-stage-program-opt-ins"]')?.textContent
    ).toBe('Avatar off · Graphics off')
    // Plan 249 S6: an older page names no stage, so the preview says so.
    // (The badge's tooltip sentence stays in the DOM as its description.)
    expect(monitor()?.textContent).toMatch(/^Program previewUnconfirmed/)
    expect(monitor()?.textContent).not.toMatch(/No picture yet|Waiting|You/)
    expect(monitor()?.dataset.programStage).toBe('unconfirmed')
    expect(monitor()?.dataset.viewSource).toBe('program-page-report')
    expect(speaker()).toBeNull()
  })

  // The owner, 2026-11-16: a takeover in the room covers the program and
  // mutes everyone, as a solo takeover does. The program page does both; the
  // monitor shows it so the host can see what went out.
  it('draws the takeover over the stage while it is up, and says everyone is muted', async () => {
    const takeover = () =>
      monitor()?.querySelector<HTMLImageElement>('[data-testid="show-stage-program-takeover"]') ??
      null
    const shownRoom = openRoom({ live: true, shown: { onStage: [HOST] } })
    studio.core.activeScreen = {
      id: 'brb',
      name: 'Be right back',
      imagePath: '/Users/test/Library/Application Support/Videorc/Screens/brb 1.png',
      sortOrder: 0,
      status: 'ready',
      createdAt: '2026-11-16T10:00:00Z',
      updatedAt: '2026-11-16T10:00:00Z'
    }
    await mount(talkStatus({ show: managedShow, room: shownRoom }), talkShow())
    expect(takeover()?.getAttribute('src')).toBe('videorc-asset://screen/brb%201.png')
    expect(monitor()?.textContent).toContain('Takeover')
    // The pills sit over the picture, never inside what Videorc Camera rasterizes.
    const picture = monitor()?.querySelector('[data-testid="show-stage-program-picture"]')
    expect(picture?.querySelector('[data-testid="show-stage-program-muted"]')).toBeNull()
    expect(picture?.querySelector('[data-testid="show-stage-program-state"]')).toBeNull()
    expect(monitor()?.querySelector('[data-testid="show-stage-program-muted"]')).not.toBeNull()

    // Not running yet: the monitor keeps its empty line, nothing is drawn.
    await mount(talkStatus({ show: managedShow, room: openRoom() }), talkShow())
    expect(takeover()).toBeNull()
    expect(monitor()?.textContent).not.toContain('everyone muted')

    // A node show's return carries the takeover itself: nothing is drawn over it.
    await mount(talkStatus({ show: nodeShow, room: openRoom({ live: true }) }), talkShow())
    expect(takeover()).toBeNull()

    // Taken down: the stage again.
    studio.core.activeScreen = null
    await mount(talkStatus({ show: managedShow, room: shownRoom }), talkShow())
    expect(takeover()).toBeNull()
    expect(monitor()?.textContent).toContain('Program preview')
    // The room's opt-ins are summed up in one line that opens Guests → Room.
    expect(
      monitor()?.querySelector('[data-testid="show-stage-program-opt-ins"]')?.textContent
    ).toBe('Avatar off · Graphics off')
    expect(monitor()?.textContent).toMatch(/^Program previewUnconfirmed/)
  })
})

// Plan 249 S6: every surface says what it shows. The Show stage is the
// room; the managed monitor is a preview of the stage the program page
// reports drawing, and says whether that is the stage this desktop sent.
describe('room view and program preview (plan 249 S6)', () => {
  const managedShow = { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' as const }
  const monitor = () => container.querySelector<HTMLElement>('[data-testid="show-stage-program"]')
  const state = () =>
    monitor()?.querySelector<HTMLElement>('[data-testid="show-stage-program-state"]') ?? null

  afterEach(() => {
    vi.useRealTimers()
  })

  // The owner, 2026-11-18 (0.31.1): the room's opt-ins live in Guests → Room;
  // the Program preview only sums them up and takes the host there.
  it('keeps the room toggles off the Program preview and links to Guests → Room', async () => {
    const opened: string[] = []
    navigation.open = (view) => opened.push(view)
    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          avatar: {
            enabled: true,
            state: 'preview',
            reason: null,
            revision: 1,
            preview: null,
            observed: {},
            guests: { enabled: false, capable: 2, applied: 0 },
            productionQualified: false
          }
        }
      })
    )
    const buttons = [...(monitor()?.querySelectorAll('button') ?? [])].map(
      (button) => button.textContent
    )
    expect(buttons.join(' ')).not.toMatch(/Enable|Hide|Show to guests|Send to Videorc Camera/)
    expect(monitor()?.querySelector('[data-testid="show-stage-guest-graphics"]')).toBeNull()
    const line = monitor()?.querySelector<HTMLButtonElement>(
      '[data-testid="show-stage-program-opt-ins"]'
    )
    expect(line?.textContent).toBe('Avatar on · Graphics off')
    await act(async () => line?.click())
    expect(opened).toEqual(['guests'])
  })

  it('labels the stage as the room, never the program', async () => {
    await mount(talkStatus({ show: managedShow, room: openRoom({ live: true }) }), talkShow())
    const well = container.querySelector<HTMLElement>('[data-testid="show-stage-well"]')
    expect(well?.dataset.viewSource).toBe('room-tracks')
    expect(well?.getAttribute('aria-label')).toBe('Room view')
    expect(container.querySelector('[data-testid="show-stage-room-label"]')?.textContent).toBe(
      'Room'
    )
  })

  // Plan 249 S12: the host's scene on the program, drawn in the preview with
  // the shared scene plan; the room view and S6's stage badge are unchanged.
  it('draws the room scene in the Program preview with the shared scene geometry', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-16T12:00:30Z'), toFake: ['Date'] })
    const { stageKey } = await import('../../../../shared/cloud-presentation-views')
    const { planSceneTiles } = await import('../../../../shared/cloud-scene')
    const fixture = (
      await import('../../../../../../../protocol-fixtures/cloud-parity-scenes.json')
    ).default
    const scene = fixture.snapshots[0].snapshot.scene as Parameters<typeof planSceneTiles>[0] & {
      id: string
    }
    const person = (identity: string) => ({
      identity,
      name: identity,
      role: identity === HOST ? ('host' as const) : ('guest' as const),
      onStage: true,
      video: true,
      audio: true,
      muted: false,
      screen: identity === HOST,
      quality: 'good' as const,
      sinceMs: 1000,
      away: false
    })
    const stage = { layout: 'side-by-side' as const, onStage: [HOST, 'g_ada'], screen: HOST }
    const roomStatus = openRoom({
      live: true,
      guests: [ada],
      participants: [person(HOST), person('g_ada')],
      stage,
      shown: {
        onStage: stage.onStage,
        screen: HOST,
        layout: stage.layout,
        stageKey: stageKey(stage),
        at: '2026-11-16T12:00:25Z'
      }
    })
    const sceneStatus = {
      enabled: true,
      state: 'applied' as const,
      reason: null,
      generation: 2,
      sceneId: { h: scene.id, v: null },
      content: { h: scene, v: null, transition: { kind: 'cut' as const, durationMs: 0 } },
      observed: {},
      productionQualified: false as const
    }
    await mount(
      talkStatus({ show: managedShow, room: roomStatus }),
      talkShow({ room: { ...NO_TALK_SHOW.room, scene: sceneStatus } })
    )
    const tiles = [
      ...(monitor()?.querySelectorAll<HTMLElement>('[data-testid="show-stage-tile"]') ?? [])
    ]
    const plan = planSceneTiles(
      scene,
      { width: 1920, height: 1080 },
      { host: HOST, guests: ['g_ada'], hostOnStage: true, screen: HOST }
    )
    expect(tiles.map((tile) => tile.dataset.sceneRole)).toEqual(plan.map((tile) => tile.role))
    tiles.forEach((tile, index) => {
      const { rect, mask, z } = plan[index]
      expect(tile.style.left).toBe(`${(rect.x / 1920) * 100}%`)
      expect(tile.style.top).toBe(`${(rect.y / 1080) * 100}%`)
      expect(tile.style.width).toBe(`${(rect.w / 1920) * 100}%`)
      expect(tile.dataset.stageShape).toBe(mask.shape)
      expect(tile.style.zIndex).toBe(String(z))
    })
    // The fixture's camera is a mirrored circle: mirrored after the crop, clipped round.
    const camera = tiles.find((tile) => tile.dataset.sceneRole === 'host-camera')!
    expect(camera.style.clipPath).toContain('circle')
    expect(
      camera.querySelector<HTMLElement>('[data-testid="show-stage-scene-clip"]')?.style.transform
    ).toBe('scaleX(-1)')
    // S6's stage confirmation is untouched; the scene has its own line.
    expect(monitor()?.dataset.programStage).toBe('applied')
    expect(state()?.textContent).toBe('Confirmed')
    expect(
      monitor()?.querySelector('[data-testid="show-stage-scene-status"]')?.textContent
    ).toMatch(/Scene drawn by each output/)
    // The room view still draws the room's own layout, never the scene.
    const well = container.querySelector<HTMLElement>('[data-testid="show-stage-well"]')
    expect(well?.querySelector('[data-scene-role]')).toBeNull()
    expect(well?.dataset.viewSource).toBe('room-tracks')

    // Scenes off: the preview is the room layout again, with no scene line.
    await mount(
      talkStatus({ show: managedShow, room: roomStatus }),
      talkShow({ room: { ...NO_TALK_SHOW.room, scene: { ...sceneStatus, enabled: false } } })
    )
    expect(monitor()?.querySelector('[data-scene-role]')).toBeNull()
    expect(monitor()?.querySelector('[data-testid="show-stage-scene-status"]')).toBeNull()
  })

  it('confirms the stage only when a fresh report names the stage sent', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-16T12:00:30Z'), toFake: ['Date'] })
    const { stageKey } = await import('../../../../shared/cloud-presentation-views')
    const base = openRoom({ live: true })
    const sentKey = stageKey(base.stage)
    const report = (key: string, at = '2026-11-16T12:00:25Z') =>
      openRoom({
        live: true,
        shown: { onStage: base.stage.onStage, layout: base.stage.layout, stageKey: key, at }
      })
    await mount(talkStatus({ show: managedShow, room: report(sentKey) }), talkShow())
    expect(monitor()?.dataset.programStage).toBe('applied')
    expect(state()?.textContent).toBe('Confirmed')

    await mount(talkStatus({ show: managedShow, room: report('00000000') }), talkShow())
    expect(monitor()?.dataset.programStage).toBe('updating')
    expect(state()?.textContent).toBe('Updating')

    await mount(
      talkStatus({ show: managedShow, room: report(sentKey, '2026-11-16T11:59:00Z') }),
      talkShow()
    )
    expect(monitor()?.dataset.programStage).toBe('stale')
    expect(state()?.textContent).toBe('Out of date')
    // Never a claim about the encoded stream.
    expect(monitor()?.textContent).not.toMatch(/on air|live now|viewers see this/i)
  })

  it('hands agents the reported program by role, never identities, and clears it', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-16T12:00:30Z'), toFake: ['Date'] })
    const { agentRoomProgram } = await import('@/lib/agent-room-program')
    const room = openRoom({ live: true, shown: { onStage: [HOST] } })
    await mount(talkStatus({ show: managedShow, room }), talkShow())
    const program = agentRoomProgram()
    expect(program?.source).toBe('program-page-report')
    expect(program?.encodedOutput).toBe(false)
    expect(program?.stage).toBe('unconfirmed')
    expect(JSON.stringify(program)).not.toContain(HOST)
    expect(program?.tiles.every((tile) => tile.role === 'host' || tile.role === 'guest')).toBe(true)
    // The stage goes (the room closes): agents lose the projection with it.
    await act(async () => root.render(createElement('div')))
    expect(agentRoomProgram()).toBeUndefined()
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

  /** The row's mic control: its name is what a press does, its `data-mic` the state. */
  const micToggle = (element: HTMLElement): HTMLButtonElement =>
    element.querySelector<HTMLButtonElement>('[data-testid="show-stage-mute"]') as HTMLButtonElement

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
    expect(micToggle(host).getAttribute('aria-label')).toBe('Mute your microphone')
    expect(row('Ada').querySelector('[data-testid="show-stage-send-backstage"]')).not.toBeNull()
  })

  it("holds a guest's mic by guest id, and mutes the host's own mic locally", async () => {
    const show = talkShow()
    await mount(talkStatus({ room: openRoom({ guests: [ada, grace] }) }), show)
    expect(micToggle(row('Ada')).getAttribute('aria-label')).toBe('Mute Ada')
    expect(micToggle(row('Grace')).getAttribute('aria-label')).toBe('Let Grace unmute')
    expect(micToggle(row('Grace')).getAttribute('aria-pressed')).toBe('true')
    await act(async () => micToggle(row('Ada')).click())
    await act(async () => micToggle(row('Grace')).click())
    await act(async () => micToggle(row('You')).click())
    expect(show.actOnGuest).toHaveBeenCalledWith('g_ada', 'mute', undefined)
    expect(show.actOnGuest).toHaveBeenCalledWith('g_grace', 'unmute', undefined)
    expect(show.setMicrophoneMuted).toHaveBeenCalledWith(true)
  })

  // Live show 2026-11-19: Unmute only lets go (D14), so the strip tells the
  // host's hold from a mic the guest still has off, and says the guest has
  // to unmute themselves.
  it("tells the host's hold, a mic still off and talking apart, and says who unmutes", async () => {
    const info = vi.spyOn(toast, 'info')
    const bo = { ...ada, guestId: 'g_bo', name: 'Bo' }
    const show = talkShow()
    await mount(
      talkStatus({
        room: openRoom({
          guests: [grace, ada, bo],
          participants: [
            ...(openRoom().participants ?? []),
            guestParticipant(grace, { audio: false }),
            guestParticipant(ada, { audio: false }),
            guestParticipant(bo)
          ]
        })
      }),
      show
    )
    // The icon is the state, its words stay for a screen reader, and the two
    // muted states each say which they are beside the name.
    const mic = (name: string): string | undefined => micToggle(row(name)).dataset.mic
    const said = (name: string): string | null | undefined =>
      row(name).querySelector('[data-testid="show-stage-mic"]')?.textContent
    expect(mic('Grace')).toBe('held')
    expect(said('Grace')).toBe('Muted by you')
    expect(micToggle(row('Grace')).getAttribute('aria-label')).toBe('Let Grace unmute')
    expect(mic('Ada')).toBe('off')
    expect(said('Ada')).toBe('Mic off')
    expect(micToggle(row('Ada')).getAttribute('aria-label')).toBe('Mute Ada')
    expect(mic('Bo')).toBe('quiet')
    expect(said('Bo')).toBeUndefined()
    expect(micToggle(row('Bo')).textContent).toBe('Quiet')
    expect(container.innerHTML).toContain('Only Ada can turn their mic on.')

    await act(async () => micToggle(row('Grace')).click())
    expect(show.actOnGuest).toHaveBeenCalledWith('g_grace', 'unmute', undefined)
    expect(info).toHaveBeenCalledWith('Grace can talk again once they unmute.', {
      id: 'videorc-guests-unmute:g_grace'
    })
    // Mute says nothing more: the strip shows the hold.
    await act(async () => micToggle(row('Bo')).click())
    expect(info).toHaveBeenCalledTimes(1)
    info.mockRestore()
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

  it('changes the layout through the cards, and waits on a screen for Screen + people', async () => {
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
    const card = (layout: string): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="show-stage-layout"][data-stage-layout="${layout}"] button`
      ) as HTMLButtonElement
    expect(card('spotlight').textContent).toBe('Spotlight')
    await act(async () => card('spotlight').click())
    expect(show.setLayout).toHaveBeenCalledWith('spotlight')
    // The layout in use is the pressed card, and choosing it again sends nothing.
    expect(card('side-by-side').getAttribute('aria-pressed')).toBe('true')
    await act(async () => card('side-by-side').click())
    expect(show.setLayout).toHaveBeenCalledTimes(1)
    expect(card('screen-people').disabled).toBe(true)
    // Each card draws its own arrangement.
    expect(
      container.querySelectorAll(
        '[data-testid="show-stage-layout"] [data-slot="stage-layout-thumb"]'
      )
    ).toHaveLength(4)
    expect(container.textContent).toContain('Share a screen first for Screen + people.')
  })
})

// Plan 252: the room in pictures. People in two lists, the shared screens as
// cards (the one home of which screen is on stage), and a guest's screen
// share as a control on their row.
describe('the room in pictures (plan 252)', () => {
  const rows = (label: string): string[] =>
    [
      ...container.querySelectorAll<HTMLElement>(
        `[aria-label="${label}"] [data-testid="show-stage-strip-row"]`
      )
    ].map((element) => element.dataset.stageIdentity ?? '')
  const screens = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-screen"]')
  ]

  it('lists people On stage and Backstage, the host first, and says when nobody is backstage', async () => {
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_grace'] }
        })
      }),
      talkShow()
    )
    expect(rows('On stage')).toEqual([HOST, 'g_grace'])
    expect(rows('Backstage')).toEqual(['g_ada'])
    // The smoke reads every row in the room, in this order.
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-strip-row"]')].map(
        (element) => element.dataset.stageIdentity
      )
    ).toEqual([HOST, 'g_grace', 'g_ada'])
    expect(container.querySelector('[data-testid="show-stage-backstage-empty"]')).toBeNull()

    await mount(talkStatus({ room: openRoom() }), talkShow())
    expect(rows('On stage')).toEqual([HOST])
    const empty = container.querySelector<HTMLElement>('[data-testid="show-stage-backstage-empty"]')
    expect(empty?.textContent).toContain('Nobody is backstage.')
    const opened: string[] = []
    navigation.open = (tab) => void opened.push(tab)
    await act(async () => empty?.querySelector('button')?.click())
    expect(opened).toEqual(['guests'])
    navigation.open = () => {}
  })

  it("puts a guest's shared screen on stage from its card, and takes it off again", async () => {
    const show = talkShow({ setStage: vi.fn(async () => {}) })
    const stage = { layout: 'side-by-side' as const, onStage: [HOST, 'g_ada'] }
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          participants: [
            ...(openRoom().participants ?? []),
            guestParticipant(ada, { onStage: true, screen: true }),
            guestParticipant(grace, { screen: true })
          ],
          stage
        })
      }),
      show
    )
    expect(screens().map((card) => card.dataset.stageIdentity)).toEqual(['g_ada', 'g_grace'])
    const adaCard = screens()[0].querySelector('button') as HTMLButtonElement
    expect(adaCard.textContent).toBe("Ada's screenPut on stage")
    // A backstage guest's screen waits for them: the stage names only who is on it.
    expect((screens()[1].querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    expect(container.innerHTML).toContain('Bring Grace on first.')
    await act(async () => adaCard.click())
    expect(show.setStage).toHaveBeenCalledWith({
      ...stage,
      layout: 'screen-people',
      screen: 'g_ada'
    })

    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada],
          participants: [
            ...(openRoom().participants ?? []),
            guestParticipant(ada, { onStage: true, screen: true })
          ],
          stage: { ...stage, layout: 'screen-people', screen: 'g_ada' }
        })
      }),
      show
    )
    expect(screens()[0].dataset.selected).toBe('true')
    await act(async () => screens()[0].querySelector('button')?.click())
    expect(show.setStage).toHaveBeenLastCalledWith({ ...stage, screen: undefined })
  })

  it('says nobody is sharing, where to allow a guest, and keeps Share screen… in Screens', async () => {
    await mount(talkStatus({ room: openRoom({ guests: [ada] }) }), talkShow())
    const section = container.querySelector<HTMLElement>('[data-testid="show-stage-screens"]')
    expect(section?.textContent).toContain('Nobody is sharing a screen.')
    expect(section?.textContent).toContain('allow it on their row')
    expect(section?.querySelector('[data-testid="show-stage-share"]')).not.toBeNull()
    expect(screens()).toHaveLength(0)
  })

  it("allows a guest's screen share from their row, and keeps it out of the ⋯ menu", async () => {
    const show = talkShow()
    await mount(talkStatus({ room: openRoom({ guests: [ada, grace] }) }), show)
    const share = (identity: string): HTMLButtonElement =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="show-stage-strip-row"][data-stage-identity="${identity}"] [data-testid="person-screen-share"]`
      ) as HTMLButtonElement
    expect(share('g_ada').dataset.screenShare).toBe('off')
    expect(share('g_grace').dataset.screenShare).toBe('allowed')
    await act(async () => share('g_ada').click())
    await act(async () => share('g_grace').click())
    expect(show.actOnGuest).toHaveBeenCalledWith('g_ada', 'allow-screen-share', undefined)
    expect(show.actOnGuest).toHaveBeenCalledWith('g_grace', 'disallow-screen-share', undefined)
  })

  it('marks who is muted and who talks on the name plates', async () => {
    await mount(
      talkStatus({
        room: openRoom({
          guests: [ada, grace],
          participants: [
            ...(openRoom().participants ?? []),
            guestParticipant(ada, { onStage: true }),
            guestParticipant(grace, { onStage: true, muted: true })
          ],
          stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada', 'g_grace'] }
        })
      }),
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          people: [
            {
              identity: 'g_ada',
              name: 'Ada',
              video: null,
              audio: null,
              screen: null,
              micMuted: false,
              cameraOff: false,
              quality: 'good',
              speaking: true
            }
          ]
        }
      })
    )
    const plates = [...container.querySelectorAll<HTMLElement>('[data-testid="show-stage-plate"]')]
    const plate = (name: string): HTMLElement =>
      plates.find((element) => element.textContent === name) as HTMLElement
    expect(plate('Ada').querySelector('[data-testid="show-stage-plate-talking"]')).not.toBeNull()
    expect(plate('Grace').querySelector('[data-testid="show-stage-plate-muted"]')).not.toBeNull()
    expect(plate('You').querySelector('[role="img"]')).toBeNull()
  })

  it('shows what the room sends as short facts, with the whole sentence kept', async () => {
    const output = {
      orientation: 'horizontal' as const,
      width: 1920,
      height: 1080,
      fps: 30,
      videoKbps: 6000,
      audioKbps: 160,
      pictureFps: 30,
      differences: []
    }
    await mount(
      talkStatus({
        show: {
          id: 'sh_talk',
          nodeId: 'livekit',
          resumable: false,
          outputProfile: {
            version: 1,
            requested: [output],
            effective: [output],
            qualification: 'phase0-1080p30-picture',
            higherProfilesQualified: false,
            pricePerHour: null,
            maxProgramEgresses: 2
          }
        },
        room: openRoom()
      }),
      talkShow()
    )
    const profile = container.querySelector<HTMLElement>(
      '[data-testid="show-stage-output-profile"]'
    )
    expect(profile?.querySelector('[data-slot="badge"]')?.textContent).toBe(
      '1920×1080 · 30 fps · 6 Mbps'
    )
    expect(profile?.textContent).toContain('One cloud output')
  })
})

// Plan 249 S5: the Program preview says why the avatar does not animate
// everywhere, in words under the picture, never in the console only.
describe('the avatar animation line under the Program preview (plan 249 S5)', () => {
  const managedShow = { id: 'sh_talk', nodeId: 'livekit', resumable: false, kind: 'talk' as const }
  const line = () =>
    container.querySelector<HTMLElement>('[data-testid="show-stage-avatar-animation"]')
  const avatar = (animation?: { state: 'animated' | 'still'; reason: string | null }) =>
    talkShow({
      room: {
        ...NO_TALK_SHOW.room,
        state: 'connected',
        avatar: {
          enabled: true,
          state: 'applied',
          reason: null,
          revision: 3,
          preview: null,
          observed: {},
          guests: { enabled: false, capable: 0, applied: 0 },
          productionQualified: false,
          ...(animation ? { animation } : {})
        }
      }
    })

  it('shows a refused atlas, a still output or a motion problem, and nothing when all is well', async () => {
    const status = talkStatus({ show: managedShow, room: openRoom({ live: true }) })
    const reason = 'The avatar shows still on cloud outputs: it is too detailed to animate there.'
    await mount(status, avatar({ state: 'still', reason }))
    expect(line()?.textContent).toBe(reason)
    expect(line()?.dataset.avatarAnimation).toBe('still')

    await mount(status, avatar({ state: 'animated', reason: null }))
    expect(line()).toBeNull()
    // A still avatar (no Alive pack) has nothing to explain.
    await mount(status, avatar())
    expect(line()).toBeNull()
  })
})
