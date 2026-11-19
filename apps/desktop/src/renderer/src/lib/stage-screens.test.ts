import { describe, expect, it } from 'vitest'

import type { CloudRoomParticipant, CloudStage } from '@/lib/backend'
import {
  addScreen,
  maxStageScreens,
  oneScreenStage,
  pruneStageScreens,
  removeScreen,
  showScreens,
  stageScreens,
  stageSharers,
  toggleStageScreen,
  twoScreensChosen,
  twoScreensStage,
  withStageScreens
} from '@/lib/stage-screens'

const HOST = 'host:sh_talk'

// Plan 251: the program shows up to two shared screens. `screen` stays the
// first on the wire and `screens` appears only for two, so every older
// reader keeps showing one screen and the people.
describe('the stage screens (plan 251)', () => {
  const stage = (over: Partial<CloudStage> = {}): CloudStage => ({
    layout: 'side-by-side',
    onStage: [HOST, 'g_ada', 'g_bo'],
    ...over
  })
  const pair = stage({ layout: 'screen-people', screen: 'g_ada', screens: ['g_ada', HOST] })

  it('reads two screens, one screen or none', () => {
    expect(stageScreens(stage())).toEqual([])
    expect(stageScreens(stage({ screen: 'g_ada' }))).toEqual(['g_ada'])
    expect(stageScreens(pair)).toEqual(['g_ada', HOST])
    // A pair that is not a pair is the one screen.
    expect(stageScreens(stage({ screen: 'g_ada', screens: ['g_ada', 'g_ada'] }))).toEqual(['g_ada'])
    expect(stageScreens(stage({ screen: 'g_ada', screens: [] }))).toEqual(['g_ada'])
  })

  it('keeps `screen` first and names `screens` only for two', () => {
    expect(withStageScreens(stage(), ['g_ada'])).toMatchObject({ screen: 'g_ada' })
    expect(withStageScreens(stage(), ['g_ada']).screens).toBeUndefined()
    const two = withStageScreens(stage(), ['g_ada', HOST, 'g_bo'])
    expect(two.screen).toBe('g_ada')
    expect(two.screens).toEqual(['g_ada', HOST])
    // Someone backstage, or the same twice, is not a second screen.
    expect(withStageScreens(stage(), ['g_ada', 'g_cy']).screens).toBeUndefined()
    expect(withStageScreens(stage(), ['g_ada', 'g_ada']).screens).toBeUndefined()
  })

  it('moves the layout with the pick: any screen is Screen + people, none is the grid', () => {
    const one = showScreens(stage(), ['g_ada'], 2)
    expect(one.layout).toBe('screen-people')
    const none = showScreens(one, [], 2)
    expect(none.layout).toBe('side-by-side')
    expect(none.screen).toBeUndefined()
    // A layout that showed no screen is left alone.
    expect(showScreens(stage({ layout: 'spotlight' }), [], 2).layout).toBe('spotlight')
  })

  it("puts the host's own share beside a guest's on Two screens, and in its place otherwise", () => {
    const guest = stage({ layout: 'screen-people', screen: 'g_ada' })
    expect(addScreen(guest, HOST, 2).screens).toEqual(['g_ada', HOST])
    // Two already up: the host's takes the last place.
    expect(addScreen(addScreen(guest, 'g_bo', 2), HOST, 2).screens).toEqual(['g_ada', HOST])
    // Any other layout, and every node show: one screen, the host's.
    const one = addScreen(guest, HOST, 1)
    expect(one.screen).toBe(HOST)
    expect(one.screens).toBeUndefined()
    expect(addScreen(stage(), HOST, 1)).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(maxStageScreens(true)).toBe(2)
    expect(maxStageScreens(false)).toBe(1)
  })

  it('takes one screen off and leaves the other up', () => {
    const left = removeScreen(pair, 'g_ada')
    expect(left).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(left.screens).toBeUndefined()
    expect(removeScreen(left, HOST)).toMatchObject({ layout: 'side-by-side' })
    expect(removeScreen(pair, 'g_bo')).toBe(pair)
    // Another layout is up: it stays, with or without a screen left.
    const spotlight = removeScreen({ ...pair, layout: 'spotlight' }, HOST)
    expect(spotlight).toMatchObject({ layout: 'spotlight', screen: 'g_ada' })
    expect(removeScreen(spotlight, 'g_ada').layout).toBe('spotlight')
  })

  it('prunes a screen whose owner left the stage', () => {
    const pruned = pruneStageScreens({ ...pair, onStage: [HOST] })
    expect(pruned.screen).toBe(HOST)
    expect(pruned.screens).toBeUndefined()
    const plain = stage()
    expect(pruneStageScreens(plain)).toBe(plain)
  })

  it('toggles a card on Two screens: on beside the other, off alone, a third not at all', () => {
    const one = stage({ layout: 'screen-people', screen: 'g_ada' })
    const two = toggleStageScreen(one, HOST)
    expect(two.screens).toEqual(['g_ada', HOST])
    expect(toggleStageScreen(two, 'g_bo')).toBe(two)
    const back = toggleStageScreen(two, 'g_ada')
    expect(back).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(back.screens).toBeUndefined()
    // The last one off: the grid.
    expect(toggleStageScreen(back, HOST).layout).toBe('side-by-side')
    // The first one on, from any layout.
    expect(toggleStageScreen(stage(), 'g_bo')).toMatchObject({
      layout: 'screen-people',
      screen: 'g_bo'
    })
  })

  it('lists who on stage shares a screen, in stage order', () => {
    const person = (identity: string, screen: boolean): CloudRoomParticipant => ({
      identity,
      name: identity,
      role: identity === HOST ? 'host' : 'guest',
      onStage: true,
      video: true,
      audio: true,
      muted: false,
      screen,
      quality: 'good',
      sinceMs: 1000,
      away: false
    })
    const room = {
      participants: [person('g_cy', true), person('g_bo', true), person('g_ada', false)],
      stage: stage()
    }
    // Cy shares but is backstage; the host's own share is the renderer's to know.
    expect(stageSharers(room, HOST, true)).toEqual([HOST, 'g_bo'])
    expect(stageSharers(room, HOST, false)).toEqual(['g_bo'])
    expect(stageSharers(undefined, HOST, true)).toEqual([])
  })

  it('the Two screens card: the screens already named, then who else shares, up to two', () => {
    // One named, one more shared: both.
    const one = stage({ layout: 'screen-people', screen: 'g_ada' })
    expect(twoScreensStage(one, ['g_ada', HOST])?.screens).toEqual(['g_ada', HOST])
    // From another layout, with nothing named: the first two sharers.
    const fresh = twoScreensStage(stage({ layout: 'spotlight' }), [HOST, 'g_ada', 'g_bo'])
    expect(fresh).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(fresh?.screens).toEqual([HOST, 'g_ada'])
    // One screen only: it goes up and the second card is waited for.
    const waiting = twoScreensStage(stage(), ['g_bo'])
    expect(waiting).toMatchObject({ layout: 'screen-people', screen: 'g_bo' })
    expect(waiting?.screens).toBeUndefined()
    // Nothing to show.
    expect(twoScreensStage(stage(), [])).toBeNull()
  })

  it('knows Two screens is chosen: picked on Screen + people, or a stage that names two', () => {
    const one = stage({ layout: 'screen-people', screen: 'g_ada' })
    expect(twoScreensChosen(one, false)).toBe(false)
    expect(twoScreensChosen(one, true)).toBe(true)
    expect(twoScreensChosen(pair, false)).toBe(true)
    // Another layout is up: not chosen, whatever was picked or is still named.
    expect(twoScreensChosen({ ...pair, layout: 'spotlight' }, true)).toBe(false)
    expect(twoScreensChosen(stage(), true)).toBe(false)
    expect(twoScreensChosen(null, true)).toBe(false)
  })

  it('the Screen + people card: one screen, never a pair', () => {
    const one = oneScreenStage(pair)
    expect(one).toMatchObject({ layout: 'screen-people', screen: 'g_ada' })
    expect(one.screens).toBeUndefined()
    expect(oneScreenStage(stage({ screen: HOST }))).toMatchObject({
      layout: 'screen-people',
      screen: HOST
    })
  })
})
