import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudRoomStatus, CloudStageLayout } from '@/lib/backend'
import { screensByOwner } from '@/lib/stage-screens'
import {
  effectiveStageLayout,
  planStage,
  showStageInput,
  shownScreens,
  stageRectPercent,
  type StageCanvas,
  type StageInput,
  type StagePlan,
  type StageRect
} from '@/lib/talk-show-layout'

// Plan 224 D8: the Show stage and the runner draw one geometry. The fixture is
// the runner's own (`videorc-cloud` crates/runner/fixtures), copied verbatim:
// every case must come out the same here, rect for rect.

type FixtureCase = {
  name: string
  canvas: StageCanvas
  layout: CloudStageLayout
  people: string[]
  spotlight?: string
  screen?: string
  plan: StagePlan
}

const cases = JSON.parse(
  readFileSync(
    new URL('../../../../../../protocol-fixtures/talk-show-layout.json', import.meta.url),
    'utf8'
  )
) as FixtureCase[]

const overlaps = (a: StageRect, b: StageRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('planStage', () => {
  it('reads the runner fixture: 1 to 6 people, every layout, three canvases', () => {
    expect(cases).toHaveLength(72)
  })

  it.each(cases.map((fixture) => [fixture.name, fixture] as const))(
    'matches the runner for %s',
    (_name, fixture) => {
      const plan = planStage(fixture.canvas, {
        layout: fixture.layout,
        people: fixture.people,
        spotlight: fixture.spotlight ?? null,
        screen: fixture.screen ?? null
      })
      expect(plan).toEqual(fixture.plan)
    }
  )

  it('keeps every tile even, inside the canvas and apart', () => {
    for (const fixture of cases) {
      const plan = planStage(fixture.canvas, {
        layout: fixture.layout,
        people: fixture.people,
        spotlight: fixture.spotlight ?? null,
        screen: fixture.screen ?? null
      })
      plan.tiles.forEach((tile, index) => {
        const { x, y, w, h } = tile.rect
        expect([x, y, w, h].every((value) => value % 2 === 0)).toBe(true)
        expect(x + w).toBeLessThanOrEqual(fixture.canvas.width)
        expect(y + h).toBeLessThanOrEqual(fixture.canvas.height)
        for (const other of plan.tiles.slice(0, index)) {
          expect(overlaps(other.rect, tile.rect)).toBe(false)
        }
      })
    }
  })

  it('draws nothing for an empty stage', () => {
    expect(planStage({ width: 1920, height: 1080 }, { layout: 'solo', people: [] })).toEqual({
      tiles: []
    })
  })

  it('falls back like the runner: Solo with two people and Screen + people with no screen', () => {
    expect(effectiveStageLayout({ layout: 'solo', people: ['host:sh', 'g_1'] })).toBe(
      'side-by-side'
    )
    expect(effectiveStageLayout({ layout: 'screen-people', people: ['host:sh'] })).toBe(
      'side-by-side'
    )
    expect(
      effectiveStageLayout({ layout: 'screen-people', people: ['host:sh'], screen: 'host:sh' })
    ).toBe('screen-people')
  })
})

// Plan 251: two screens across the top, everyone on stage in a row under
// them. The web's program page draws from the same fixture.
describe('the two-screens layout (plan 251)', () => {
  type TwoScreensCase = {
    name: string
    canvas: StageCanvas
    layout: 'two-screens'
    people: string[]
    /** Everyone on the stage, when the row draws fewer (someone is away). */
    onStage?: string[]
    /** As the stage names them: the first one put up first. */
    screens: string[]
    plan: StagePlan
  }
  const twoScreens = JSON.parse(
    readFileSync(
      new URL(
        '../../../../../../protocol-fixtures/talk-show-two-screens-layout.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as TwoScreensCase[]
  const input = (fixture: TwoScreensCase) => ({
    layout: 'screen-people' as const,
    people: fixture.people,
    ...(fixture.onStage ? { onStage: fixture.onStage } : {}),
    screen: fixture.screens[0],
    screens: fixture.screens
  })

  it('covers 1 to 6 people on three canvases', () => {
    // And, on each canvas, the two owner-side cases: the guest's screen up
    // first, and an owner away from the row.
    expect(twoScreens).toHaveLength(24)
  })

  it.each(twoScreens.map((fixture) => [fixture.name, fixture] as const))(
    'matches the fixture for %s',
    (_name, fixture) => {
      expect(effectiveStageLayout(input(fixture))).toBe('two-screens')
      expect(planStage(fixture.canvas, input(fixture))).toEqual(fixture.plan)
    }
  )

  it('keeps every tile even, inside the canvas and apart, the screens first', () => {
    for (const fixture of twoScreens) {
      const plan = planStage(fixture.canvas, input(fixture))
      expect(plan.tiles.slice(0, 2).map((tile) => [tile.kind, tile.identity])).toEqual(
        screensByOwner(fixture.screens, fixture.onStage ?? fixture.people).map((identity) => [
          'screen',
          identity
        ])
      )
      expect(plan.tiles.slice(2).map((tile) => tile.identity)).toEqual(fixture.people)
      const [first, second] = plan.tiles
      expect(first.rect.w).toBe(second.rect.w)
      expect(first.rect.h).toBe(second.rect.h)
      plan.tiles.forEach((tile, index) => {
        const { x, y, w, h } = tile.rect
        expect([x, y, w, h].every((value) => value % 2 === 0)).toBe(true)
        expect(x + w).toBeLessThanOrEqual(fixture.canvas.width)
        expect(y + h).toBeLessThanOrEqual(fixture.canvas.height)
        for (const other of plan.tiles.slice(0, index)) {
          expect(overlaps(other.rect, tile.rect)).toBe(false)
        }
      })
    }
  })

  // The owner, live on 2026-11-20: "My screen recording is above the guest
  // and the guest's screen recording is above me." The guest had shared
  // first, so the stage named the guest's screen first.
  it("draws each screen above its owner's camera, whichever went up first", () => {
    const centre = (tile: { rect: { x: number; w: number } }): number =>
      tile.rect.x + tile.rect.w / 2
    const people = ['host:sh', 'g_1']
    for (const screens of [
      ['g_1', 'host:sh'],
      ['host:sh', 'g_1']
    ]) {
      const plan = planStage(
        { width: 1920, height: 1080 },
        { layout: 'screen-people', people, screen: screens[0], screens }
      )
      const tile = (kind: 'person' | 'screen', identity: string) =>
        plan.tiles.find((entry) => entry.kind === kind && entry.identity === identity)!
      for (const identity of people) {
        expect(centre(tile('screen', identity))).toBe(centre(tile('person', identity)))
        expect(tile('screen', identity).rect.y).toBeLessThan(tile('person', identity).rect.y)
      }
      expect(plan.tiles.slice(0, 2).map((entry) => entry.identity)).toEqual(people)
    }
    // Stacked on a portrait canvas: the first person's screen on top.
    const portrait = planStage(
      { width: 1080, height: 1920 },
      { layout: 'screen-people', people, screen: 'g_1', screens: ['g_1', 'host:sh'] }
    )
    expect(portrait.tiles.slice(0, 2).map((entry) => entry.identity)).toEqual(people)
    expect(portrait.tiles[0].rect.y).toBeLessThan(portrait.tiles[1].rect.y)
  })

  it('keeps each screen on its side while its owner is away from the row', () => {
    const canvas = { width: 1920, height: 1080 }
    const stage = { layout: 'screen-people' as const, screen: 'g_1', screens: ['g_1', 'host:sh'] }
    const onStage = ['host:sh', 'g_1']
    const both = planStage(canvas, { ...stage, people: onStage, onStage })
    // The host was away for a minute: the row re-flows, the screens do not swap.
    const hostAway = planStage(canvas, { ...stage, people: ['g_1'], onStage })
    expect(hostAway.tiles.slice(0, 2)).toEqual(both.tiles.slice(0, 2))
    expect(hostAway.tiles.slice(0, 2).map((entry) => entry.identity)).toEqual(onStage)
  })

  it('falls back to one screen and the people, then to the grid', () => {
    const people = ['host:sh', 'g_1']
    const one = { layout: 'screen-people' as const, people, screen: 'g_1', screens: ['g_1'] }
    expect(effectiveStageLayout(one)).toBe('screen-people')
    expect(planStage({ width: 1920, height: 1080 }, one)).toEqual(
      planStage({ width: 1920, height: 1080 }, { layout: 'screen-people', people, screen: 'g_1' })
    )
    expect(effectiveStageLayout({ layout: 'screen-people', people, screens: [] })).toBe(
      'side-by-side'
    )
    // Two screens are drawn only on Screen + people.
    expect(
      effectiveStageLayout({
        layout: 'spotlight',
        people,
        screen: 'g_1',
        screens: ['g_1', 'host:sh']
      })
    ).toBe('spotlight')
  })

  it('draws the two screens the program reports, and one when it shows one', () => {
    const base = {
      phase: 'open',
      doorOpen: false,
      declinedCount: 0,
      participants: [],
      stage: {
        layout: 'screen-people',
        onStage: ['host:sh', 'g_1'],
        screen: 'g_1',
        screens: ['g_1', 'host:sh']
      },
      hostAway: false,
      connected: true,
      client: 'connected',
      returnEnabled: false,
      stageSet: true,
      live: false
    } satisfies CloudRoomStatus
    expect(showStageInput(base).screens).toEqual(['g_1', 'host:sh'])
    // The Show stage draws them as the program does: the host's on the left,
    // over the host, before the page reports and after.
    const drawn = (input: StageInput): string[] =>
      planStage({ width: 1920, height: 1080 }, input)
        .tiles.filter((tile) => tile.kind === 'screen')
        .map((tile) => tile.identity)
    expect(drawn(showStageInput(base))).toEqual(['host:sh', 'g_1'])
    const both = showStageInput({
      ...base,
      shown: { onStage: ['host:sh', 'g_1'], screen: 'host:sh', screens: ['host:sh', 'g_1'] }
    })
    expect(effectiveStageLayout(both)).toBe('two-screens')
    expect(drawn(both)).toEqual(['host:sh', 'g_1'])
    // A page from before the fix reports them as the stage named them.
    const older = showStageInput({
      ...base,
      shown: { onStage: ['host:sh', 'g_1'], screen: 'g_1', screens: ['g_1', 'host:sh'] }
    })
    expect(drawn(older)).toEqual(['host:sh', 'g_1'])
    // The page shows only the host's (the guest's went stale).
    const one = showStageInput({
      ...base,
      shown: { onStage: ['host:sh', 'g_1'], screen: 'host:sh' }
    })
    expect(one.screen).toBe('host:sh')
    expect(one.screens).toBeUndefined()
    expect(effectiveStageLayout(one)).toBe('screen-people')
    expect(shownScreens({ screens: ['a', 'a', 'b', 'c'] })).toEqual(['a', 'b'])
  })
})

describe('stageRectPercent', () => {
  it('places a rect as percentages of its canvas', () => {
    expect(
      stageRectPercent({ width: 1920, height: 1080 }, { x: 960, y: 270, w: 480, h: 540 })
    ).toEqual({ left: '50%', top: '25%', width: '25%', height: '50%' })
  })
})

describe('showStageInput (review M2)', () => {
  const HOST = 'host:sh_talk'
  const person = (identity: string, onStage: boolean) => ({
    identity,
    name: identity,
    role: identity === HOST ? ('host' as const) : ('guest' as const),
    onStage,
    video: true,
    audio: true,
    muted: false,
    screen: false,
    quality: 'good' as const,
    sinceMs: 1000,
    away: false
  })
  const room = (overrides: Partial<CloudRoomStatus> = {}): CloudRoomStatus => ({
    phase: 'open',
    doorOpen: false,
    declinedCount: 0,
    participants: [person(HOST, true), person('g_ada', true), person('g_bo', true)],
    stage: {
      layout: 'screen-people',
      onStage: [HOST, 'g_ada', 'g_bo'],
      screen: 'g_ada'
    },
    hostAway: false,
    connected: true,
    client: 'connected',
    returnEnabled: false,
    stageSet: true,
    live: false,
    ...overrides
  })

  it('draws the stage as sent while the runner reports nothing', () => {
    expect(showStageInput(room())).toEqual({
      layout: 'screen-people',
      people: [HOST, 'g_ada', 'g_bo'],
      onStage: [HOST, 'g_ada', 'g_bo'],
      spotlight: null,
      screen: 'g_ada'
    })
    expect(showStageInput(undefined)).toEqual({
      layout: 'solo',
      people: [],
      spotlight: null,
      screen: null
    })
  })

  it('leaves out who the runner re-flowed and shows the screen the program shows', () => {
    const input = showStageInput(room({ shown: { onStage: [HOST, 'g_ada'], screen: 'g_bo' } }))
    expect(input.people).toEqual([HOST, 'g_ada'])
    expect(input.screen).toBe('g_bo')
    // A stale named screen with none to stand in: Side by side, as the program.
    const stale = room({ shown: { onStage: [HOST, 'g_ada', 'g_bo'] } })
    expect(showStageInput(stale).screen).toBeNull()
    expect(effectiveStageLayout(showStageInput(stale))).toBe('side-by-side')
  })

  it('never waits on the runner for a Bring on or a Send backstage', () => {
    // Cy was just brought on: not on the runner's stage yet, so drawn.
    const broughtOn = room({
      participants: [person(HOST, true), person('g_ada', true), person('g_cy', false)],
      stage: { layout: 'side-by-side', onStage: [HOST, 'g_ada', 'g_cy'] },
      shown: { onStage: [HOST, 'g_ada'] }
    })
    expect(showStageInput(broughtOn).people).toEqual([HOST, 'g_ada', 'g_cy'])
    // Ada was just sent backstage: gone at once, whatever the runner drew.
    const sentBack = room({
      stage: { layout: 'side-by-side', onStage: [HOST, 'g_bo'] },
      shown: { onStage: [HOST, 'g_ada', 'g_bo'], screen: 'g_ada' }
    })
    expect(showStageInput(sentBack).people).toEqual([HOST, 'g_bo'])
    expect(showStageInput(sentBack).screen).toBeNull()
  })
})
