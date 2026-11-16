// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudRoomGuest, CloudStageLayout, CloudStatus, StreamScreen } from '@/lib/backend'
import { HOST, ada, grace, openRoom, talkStatus } from '@/lib/guests-room-fixtures'
import { NO_TALK_SHOW, type TalkShowContextValue } from '@/lib/talk-show-context'
import { planStage } from '@/lib/talk-show-layout'

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
    expect(
      monitor()?.querySelector('[data-testid="show-stage-avatar-status"]')?.textContent
    ).toContain('Room avatar off')
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
    expect(
      monitor()?.querySelector('[data-testid="show-stage-avatar-status"]')?.textContent
    ).toContain('Room avatar off')
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

  it('offers guests the avatar only once it is on, and says how many confirmed', async () => {
    const avatar = (
      enabled: boolean,
      guests: { enabled: boolean; capable: number; applied: number }
    ) => ({
      enabled,
      state: 'preview' as const,
      reason: null,
      revision: 1,
      preview: null,
      observed: {},
      guests,
      productionQualified: false as const
    })
    const row = () =>
      monitor()?.querySelector<HTMLElement>('[data-testid="show-stage-guest-graphics"]') ?? null
    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          avatar: avatar(false, { enabled: false, capable: 0, applied: 0 })
        }
      })
    )
    expect(row()).toBeNull()

    const setAvatarGuests = vi.fn(async () => {})
    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({
        setAvatarGuests,
        room: {
          ...NO_TALK_SHOW.room,
          avatar: avatar(true, { enabled: false, capable: 2, applied: 0 })
        }
      })
    )
    expect(row()?.textContent).toContain("Guests don't see the avatar")
    const button = row()?.querySelector('button')
    expect(button?.getAttribute('aria-pressed')).toBe('false')
    await act(async () => button?.click())
    expect(setAvatarGuests).toHaveBeenCalledWith(true)

    await mount(
      talkStatus({ show: managedShow, room: openRoom({ live: true }) }),
      talkShow({
        room: {
          ...NO_TALK_SHOW.room,
          avatar: avatar(true, { enabled: true, capable: 3, applied: 2 })
        }
      })
    )
    expect(row()?.textContent).toContain('Shown to guests · 2 of 3 confirmed')
    expect(row()?.querySelector('button')?.textContent).toBe('Hide from guests')
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
