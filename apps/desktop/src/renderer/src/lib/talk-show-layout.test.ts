import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { CloudStageLayout } from '@/lib/backend'
import {
  effectiveStageLayout,
  planStage,
  stageRectPercent,
  type StageCanvas,
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

describe('stageRectPercent', () => {
  it('places a rect as percentages of its canvas', () => {
    expect(
      stageRectPercent({ width: 1920, height: 1080 }, { x: 960, y: 270, w: 480, h: 540 })
    ).toEqual({ left: '50%', top: '25%', width: '25%', height: '50%' })
  })
})
