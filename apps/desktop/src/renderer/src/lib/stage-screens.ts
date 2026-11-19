import type { CloudRoomStatus, CloudStage } from '@/lib/backend'

// Plan 251: which screens the program shows. The host shares their own
// screen, a guest shares theirs once allowed, and the host puts up to two
// of them on stage from the Show stage's Screens cards (plan 252). One
// screen is `screen-people`; two are the two-screens layout: the screens
// side by side and everyone on stage in a row under them.
//
// On the wire a stage keeps its one `screen`, and names both in `screens`
// only when there are two. An older desktop, program page, guest page or
// runner reads `screen` and shows that one. Pure, so each rule is a test.

/** The most screens a stage shows at once. */
export const STAGE_MAX_SCREENS = 2

/**
 * The screens a stage shows, in order: its two `screens` when it names two
 * different ones, else its one `screen`, else none.
 */
export function stageScreens(stage: {
  screen?: string | null
  screens?: readonly string[] | null
}): string[] {
  const named: string[] = []
  for (const identity of stage.screens ?? []) {
    if (identity.length > 0 && !named.includes(identity)) named.push(identity)
  }
  if (named.length >= STAGE_MAX_SCREENS) return named.slice(0, STAGE_MAX_SCREENS)
  if (stage.screen) return [stage.screen]
  return named
}

/** A managed show can show two screens; a node show's runner draws one. */
export function maxStageScreens(managed: boolean): number {
  return managed ? STAGE_MAX_SCREENS : 1
}

export const TWO_SCREENS_AT_MOST = 'Two screens are on stage. Take one off first.'
export const ONE_SCREEN_ON_THIS_SHOW = 'This show puts one screen on the program.'

/**
 * The stage with its screens put right: each one on stage, each once, at
 * most two; `screen` is the first and `screens` is there only for two.
 * The layout is left alone.
 */
export function withStageScreens(stage: CloudStage, chosen: readonly string[]): CloudStage {
  const kept: string[] = []
  for (const identity of chosen) {
    if (stage.onStage.includes(identity) && !kept.includes(identity)) kept.push(identity)
  }
  const screens = kept.slice(0, STAGE_MAX_SCREENS)
  return {
    ...stage,
    screen: screens[0],
    screens: screens.length === STAGE_MAX_SCREENS ? screens : undefined
  }
}

/** A stage whose screens may name someone who left it: the same, put right. */
export function pruneStageScreens(stage: CloudStage): CloudStage {
  if (!stage.screen && !stage.screens) return stage
  return withStageScreens(stage, stageScreens(stage))
}

/**
 * The host's pick: these screens on the program. Any screen moves the
 * layout to Screen + people; none moves it back to Side by side.
 */
export function showScreens(stage: CloudStage, chosen: readonly string[], max: number): CloudStage {
  const next = withStageScreens(stage, chosen.slice(0, Math.max(0, max)))
  const layout = next.screen
    ? 'screen-people'
    : stage.layout === 'screen-people'
      ? 'side-by-side'
      : stage.layout
  return { ...next, layout }
}

/**
 * One more screen on the stage: beside the one already there while there is
 * room (`max` 2, the two-screens layout), else in its place (`max` 1).
 */
export function addScreen(stage: CloudStage, identity: string, max: number): CloudStage {
  const current = stageScreens(stage)
  if (current.includes(identity)) return showScreens(stage, current, max)
  const kept = current.slice(0, Math.max(0, max - 1))
  return showScreens(stage, [...kept, identity], max)
}

/**
 * A screen off the stage; the other one, when there is one, stays. Screen +
 * people with no screen left goes back to Side by side; any other layout
 * stays as it is.
 */
export function removeScreen(stage: CloudStage, identity: string): CloudStage {
  const current = stageScreens(stage)
  if (!current.includes(identity)) return stage
  const next = withStageScreens(
    stage,
    current.filter((entry) => entry !== identity)
  )
  return {
    ...next,
    layout: stage.layout === 'screen-people' && !next.screen ? 'side-by-side' : stage.layout
  }
}

/**
 * A card's click while the two-screens layout is chosen: a screen on stage
 * comes off; one that is off goes on beside the other, while there is room
 * for it. A third changes nothing (its card says why).
 */
export function toggleStageScreen(stage: CloudStage, identity: string): CloudStage {
  const current = stageScreens(stage)
  if (current.includes(identity)) return removeScreen(stage, identity)
  if (current.length >= STAGE_MAX_SCREENS) return stage
  return showScreens(stage, [...current, identity], STAGE_MAX_SCREENS)
}

/**
 * Whether the Two screens layout card is the one chosen. On the wire it is
 * Screen + people with one or two screens, so the choice is the renderer's:
 * `picked` by the card, kept while Screen + people is up, and read back from
 * a stage that names two (after a relaunch, or from another computer).
 */
export function twoScreensChosen(stage: CloudStage | null | undefined, picked: boolean): boolean {
  if (!stage || stage.layout !== 'screen-people') return false
  return picked || stageScreens(stage).length === STAGE_MAX_SCREENS
}

/** Who on stage shares a screen now, in stage order. */
export function stageSharers(
  room: Pick<CloudRoomStatus, 'participants' | 'stage'> | undefined,
  hostIdentity: string | null,
  hostSharing: boolean
): string[] {
  if (!room) return []
  const sharing = new Set(
    (room.participants ?? [])
      .filter((participant) => participant.screen)
      .map((participant) => participant.identity)
  )
  if (hostIdentity && hostSharing) sharing.add(hostIdentity)
  return room.stage.onStage.filter((identity) => sharing.has(identity))
}

/**
 * The Two screens layout card: the screens the stage already names, then
 * whoever else on stage shares one, up to two. With one it shows that one
 * and waits for the second card; with none there is nothing to show (null).
 */
export function twoScreensStage(stage: CloudStage, sharers: readonly string[]): CloudStage | null {
  const named = stageScreens(stage).filter((identity) => stage.onStage.includes(identity))
  const picks = [...named, ...sharers.filter((identity) => !named.includes(identity))]
  if (picks.length === 0) return null
  return showScreens(stage, picks, STAGE_MAX_SCREENS)
}

/** The Screen + people layout card: the stage's one screen, never a pair. */
export function oneScreenStage(stage: CloudStage): CloudStage {
  return { ...withStageScreens(stage, stageScreens(stage).slice(0, 1)), layout: 'screen-people' }
}
