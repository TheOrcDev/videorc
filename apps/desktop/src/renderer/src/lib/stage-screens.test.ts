import { describe, expect, it } from 'vitest'

import type { CloudRoomParticipant, CloudStage } from '@/lib/backend'
import {
  ONE_SCREEN_ON_THIS_SHOW,
  TWO_SCREENS_AT_MOST,
  addScreen,
  maxStageScreens,
  programScreens,
  pruneStageScreens,
  removeScreen,
  showScreens,
  stageScreenChoices,
  stageScreens,
  toggleStageScreen,
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

  it('reads two screens, one screen or none', () => {
    expect(stageScreens(stage())).toEqual([])
    expect(stageScreens(stage({ screen: 'g_ada' }))).toEqual(['g_ada'])
    expect(stageScreens(stage({ screen: 'g_ada', screens: ['g_ada', HOST] }))).toEqual([
      'g_ada',
      HOST
    ])
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

  it("puts the host's own share beside a guest's, and in the last place when full", () => {
    const guest = stage({ layout: 'screen-people', screen: 'g_ada' })
    expect(addScreen(guest, HOST, 2).screens).toEqual(['g_ada', HOST])
    const full = addScreen(guest, 'g_bo', 2)
    expect(addScreen(full, HOST, 2).screens).toEqual(['g_ada', HOST])
    // A node show draws one: the host's share takes the place, as before.
    const node = addScreen(guest, HOST, 1)
    expect(node.screen).toBe(HOST)
    expect(node.screens).toBeUndefined()
    expect(addScreen(stage(), HOST, 2)).toMatchObject({ layout: 'screen-people', screen: HOST })
  })

  it('takes one screen off and leaves the other up', () => {
    const two = stage({ layout: 'screen-people', screen: 'g_ada', screens: ['g_ada', HOST] })
    const left = removeScreen(two, 'g_ada')
    expect(left).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(left.screens).toBeUndefined()
    expect(removeScreen(left, HOST)).toMatchObject({ layout: 'side-by-side' })
    expect(removeScreen(two, 'g_bo')).toBe(two)
    // Another layout is up: it stays, with or without a screen left.
    const spotlight = removeScreen({ ...two, layout: 'spotlight' }, HOST)
    expect(spotlight).toMatchObject({ layout: 'spotlight', screen: 'g_ada' })
    expect(removeScreen(spotlight, 'g_ada').layout).toBe('spotlight')
  })

  it('counts a named screen as on the program only on Screen + people', () => {
    const named = stage({ layout: 'spotlight', screen: 'g_ada' })
    expect(programScreens(named)).toEqual([])
    expect(programScreens({ ...named, layout: 'screen-people' })).toEqual(['g_ada'])
    // Ticking another screen from there shows that one, not the stale pair.
    const picked = toggleStageScreen(named, HOST, true, 2)
    expect(picked).toMatchObject({ layout: 'screen-people', screen: HOST })
    expect(picked.screens).toBeUndefined()
    expect(toggleStageScreen(named, 'g_ada', false, 2)).toBe(named)
    expect(addScreen(named, HOST, 2).screens).toBeUndefined()
  })

  it('prunes a screen whose owner left the stage', () => {
    const two = stage({
      layout: 'screen-people',
      onStage: [HOST],
      screen: 'g_ada',
      screens: ['g_ada', HOST]
    })
    const pruned = pruneStageScreens(two)
    expect(pruned.screen).toBe(HOST)
    expect(pruned.screens).toBeUndefined()
    const plain = stage()
    expect(pruneStageScreens(plain)).toBe(plain)
  })

  it('ticks up to two on a managed show and swaps on a node show', () => {
    const one = stage({ layout: 'screen-people', screen: 'g_ada' })
    expect(toggleStageScreen(one, HOST, true, 2).screens).toEqual(['g_ada', HOST])
    const two = toggleStageScreen(one, HOST, true, 2)
    expect(toggleStageScreen(two, 'g_bo', true, 2)).toBe(two)
    expect(toggleStageScreen(two, 'g_ada', false, 2).screen).toBe(HOST)
    const swapped = toggleStageScreen(one, HOST, true, 1)
    expect(swapped.screen).toBe(HOST)
    expect(swapped.screens).toBeUndefined()
    expect(maxStageScreens(true)).toBe(2)
    expect(maxStageScreens(false)).toBe(1)
  })

  it('lists who shares a screen on stage, and why a third waits', () => {
    const person = (identity: string, name: string, screen: boolean): CloudRoomParticipant => ({
      identity,
      name,
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
    const participants = [
      person(HOST, 'Orc', false),
      person('g_ada', 'Ada', true),
      person('g_bo', 'Bo', true),
      person('g_cy', 'Cy', true)
    ]
    const room = {
      participants,
      stage: stage({ layout: 'screen-people', screen: 'g_ada', screens: ['g_ada', HOST] })
    }
    const managed = stageScreenChoices(room, {
      hostIdentity: HOST,
      hostSharing: true,
      managed: true
    })
    // Cy shares but is backstage: not a choice.
    expect(managed).toEqual([
      { identity: HOST, label: 'Your screen', checked: true, disabledReason: null },
      { identity: 'g_ada', label: "Ada's screen", checked: true, disabledReason: null },
      {
        identity: 'g_bo',
        label: "Bo's screen",
        checked: false,
        disabledReason: TWO_SCREENS_AT_MOST
      }
    ])
    // The host stopped sharing: their named screen stays listed, to take off.
    const stopped = stageScreenChoices(room, {
      hostIdentity: HOST,
      hostSharing: false,
      managed: true
    })
    expect(stopped.map((choice) => choice.identity)).toEqual([HOST, 'g_ada', 'g_bo'])
    const node = stageScreenChoices(
      { participants, stage: stage({ layout: 'screen-people', screen: 'g_ada' }) },
      { hostIdentity: HOST, hostSharing: false, managed: false }
    )
    expect(node.every((choice) => choice.disabledReason === null)).toBe(true)
    expect(ONE_SCREEN_ON_THIS_SHOW).toMatch(/one screen/)
    expect(
      stageScreenChoices(undefined, { hostIdentity: HOST, hostSharing: true, managed: true })
    ).toEqual([])
  })
})
