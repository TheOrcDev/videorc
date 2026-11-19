import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  PROGRAM_PREVIEW_STALE_MS,
  STAGE_KEY_PATTERN,
  canonicalStage,
  fitBox,
  fitScale,
  isPortrait,
  personFit,
  personPicture,
  portraitCoverBox,
  programPreviewStage,
  stageKey,
  tileFit,
  type KeyedStage,
  type TileFit
} from './cloud-presentation-views'

type Vectors = {
  version: 1
  fit: {
    name: string
    source: { w: number; h: number }
    tile: { w: number; h: number }
    fit: TileFit
    box: { x: number; y: number; w: number; h: number } | null
  }[]
  person: {
    name: string
    source: { w: number; h: number }
    tile: { w: number; h: number }
    was: boolean
    portrait: boolean
    fit: TileFit
    fill: { x: number; y: number; w: number; h: number } | null
    picture: { x: number; y: number; w: number; h: number }
  }[]
  stages: { name: string; stage: KeyedStage; canonical: string; key: string }[]
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../protocol-fixtures/cloud-parity-views.json', import.meta.url),
    'utf8'
  )
) as Vectors

describe('cloud presentation views (plan 249 S6)', () => {
  it('covers people and contains screens', () => {
    expect(tileFit('person')).toBe('cover')
    expect(tileFit('screen')).toBe('contain')
    expect(fitBox({ w: 1920, h: 1200 }, { w: 1920, h: 1080 }, 'contain')).toEqual({
      x: 96,
      y: 0,
      w: 1728,
      h: 1080
    })
    expect(fitBox({ w: 640, h: 480 }, { w: 1280, h: 720 }, 'cover')).toEqual({
      x: 0,
      y: 60,
      w: 640,
      h: 360
    })
    expect(fitScale({ w: 3440, h: 1440 }, { w: 1280, h: 720 }, 'contain')).toBe(1280 / 3440)
  })

  it('holds the shared fit and stage-key vectors the web also runs', () => {
    expect(vectors.version).toBe(1)
    for (const one of vectors.fit) {
      expect(fitBox(one.source, one.tile, one.fit), one.name).toEqual(one.box)
    }
    for (const one of vectors.stages) {
      expect(canonicalStage(one.stage), one.name).toBe(one.canonical)
      expect(stageKey(one.stage), one.name).toBe(one.key)
      expect(stageKey(one.stage)).toMatch(STAGE_KEY_PATTERN)
    }
  })

  it('draws a portrait camera whole over a fill, and a landscape one as before (plan 254 S2)', () => {
    expect(personFit(false)).toEqual({ fill: false, fit: 'cover' })
    expect(personFit(true)).toEqual({ fill: true, fit: 'contain' })
    const phone = { w: 720, h: 1280 }
    const solo = { w: 1920, h: 1080 }
    expect(personPicture(phone, solo, true)?.picture).toEqual({
      x: 656.25,
      y: 0,
      w: 607.5,
      h: 1080
    })
    const laptop = { w: 1280, h: 720 }
    expect(personPicture(laptop, { w: 944, h: 1080 }, false)).toEqual({
      fill: null,
      fit: 'cover',
      picture: fitBox(laptop, { w: 944, h: 1080 }, 'cover')
    })
    // The cover window of a portrait source sits on its upper third.
    const box = portraitCoverBox(phone, solo)
    expect(box?.h).toBe(405)
    expect((box?.y ?? 0) + 405 / 2).toBeCloseTo(1280 / 3, 9)
    expect(portraitCoverBox(phone, { w: 720, h: 1080 })).toEqual({ x: 0, y: 0, w: 720, h: 1080 })
  })

  it('keeps a source near square the fit it had (plan 254 S2)', () => {
    expect(isPortrait({ w: 720, h: 1280 })).toBe(true)
    expect(isPortrait({ w: 1280, h: 720 }, true)).toBe(false)
    expect(isPortrait({ w: 480, h: 500 }, false)).toBe(false)
    expect(isPortrait({ w: 480, h: 500 }, true)).toBe(true)
    expect(isPortrait({ w: 480, h: 480 }, true)).toBe(false)
    expect(isPortrait({ w: 2, h: 2 }, true)).toBe(true)
  })

  it('holds the shared person vectors the web also runs (plan 254 S2)', () => {
    expect(vectors.person.length).toBeGreaterThan(0)
    for (const one of vectors.person) {
      const portrait = isPortrait(one.source, one.was)
      expect(portrait, one.name).toBe(one.portrait)
      expect(personPicture(one.source, one.tile, portrait), one.name).toEqual({
        fill: one.fill,
        fit: one.fit,
        picture: one.picture
      })
    }
  })

  describe('programPreviewStage', () => {
    const sent: KeyedStage = { layout: 'side-by-side', onStage: ['host:s', 'g_a'] }
    const now = Date.parse('2026-11-16T12:00:30Z')
    const at = '2026-11-16T12:00:25Z'

    it('is empty before any output and waiting before any report', () => {
      expect(programPreviewStage({ running: false, sent, shown: undefined, now }).state).toBe(
        'empty'
      )
      expect(programPreviewStage({ running: true, sent, shown: undefined, now }).state).toBe(
        'waiting'
      )
    })

    it('calls the stage applied only when a fresh report names the sent stage', () => {
      const applied = programPreviewStage({
        running: true,
        sent,
        shown: { at, stageKey: stageKey(sent) },
        now
      })
      expect(applied).toEqual({
        state: 'applied',
        ageMs: 5000,
        appliedKey: stageKey(sent),
        encodedOutput: false
      })
      const older = { ...sent, layout: 'spotlight' }
      expect(
        programPreviewStage({ running: true, sent, shown: { at, stageKey: stageKey(older) }, now })
          .state
      ).toBe('updating')
    })

    it('never invents an acknowledgement for an older page or a bad clock', () => {
      expect(programPreviewStage({ running: true, sent, shown: {}, now }).state).toBe('unconfirmed')
      expect(
        programPreviewStage({ running: true, sent, shown: { stageKey: stageKey(sent) }, now }).state
      ).toBe('unconfirmed')
      expect(
        programPreviewStage({
          running: true,
          sent,
          shown: { at: 'garbage', stageKey: stageKey(sent) },
          now
        }).state
      ).toBe('unconfirmed')
      expect(
        programPreviewStage({
          running: true,
          sent,
          shown: { at, stageKey: 'NOT-HEX!' },
          now
        }).state
      ).toBe('unconfirmed')
      // A report from the future (clock skew) is not trusted.
      expect(
        programPreviewStage({
          running: true,
          sent,
          shown: { at: '2026-11-16T12:01:00Z', stageKey: stageKey(sent) },
          now
        }).state
      ).toBe('unconfirmed')
      // Nothing sent: there is nothing to compare with.
      expect(
        programPreviewStage({ running: true, sent: null, shown: { at, stageKey: 'aaaaaaaa' }, now })
          .state
      ).toBe('unconfirmed')
    })

    it('goes stale when the report is older than the web keeps one', () => {
      const old = new Date(now - PROGRAM_PREVIEW_STALE_MS - 1).toISOString()
      expect(
        programPreviewStage({
          running: true,
          sent,
          shown: { at: old, stageKey: stageKey(sent) },
          now
        }).state
      ).toBe('stale')
    })
  })
})
