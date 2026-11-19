import type { CloudRoomStatus, CloudStage } from '@/lib/backend'

// Plan 251: which screens the program shows. The host shares their own
// screen, a guest shares theirs once allowed, and the host picks up to two
// of them. One screen is `screen-people`; two are the two-screens layout:
// the screens side by side and everyone on stage in a row under them.
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

export const TWO_SCREENS_AT_MOST = 'The program shows two screens at most. Take one off first.'
export const UP_TO_TWO_SCREENS = 'Show up to two screens'
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
 * The screens on the program now. A stage keeps naming its screens while
 * another layout is up (Screen + people brings them back); they are on the
 * program only on Screen + people.
 */
export function programScreens(stage: CloudStage): string[] {
  return stage.layout === 'screen-people' ? stageScreens(stage) : []
}

/**
 * One more screen on the program (the host starts sharing): beside the one
 * already there while there is room, else in the last place.
 */
export function addScreen(stage: CloudStage, identity: string, max: number): CloudStage {
  const current = programScreens(stage)
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

export type StageScreenChoice = {
  identity: string
  label: string
  checked: boolean
  /** Why it can't be ticked now. Null: it can. An unticking is never blocked. */
  disabledReason: string | null
}

/**
 * The picker's rows: everyone on stage who shares a screen now, and every
 * screen on the program (so one that stopped can be taken off).
 */
export function stageScreenChoices(
  room: Pick<CloudRoomStatus, 'participants' | 'stage'> | undefined,
  options: { hostIdentity: string | null; hostSharing: boolean; managed: boolean }
): StageScreenChoice[] {
  if (!room) return []
  const selected = programScreens(room.stage)
  const max = maxStageScreens(options.managed)
  // With room for one, a tick takes the other's place; nothing is blocked.
  const full = max > 1 && selected.length >= max
  const sharing = (identity: string): boolean =>
    identity === options.hostIdentity
      ? options.hostSharing
      : (room.participants ?? []).some(
          (participant) => participant.identity === identity && participant.screen
        )
  const nameOf = (identity: string): string => {
    if (identity === options.hostIdentity) return 'Your screen'
    const name = (room.participants ?? []).find((entry) => entry.identity === identity)?.name
    return name ? `${name}'s screen` : "A guest's screen"
  }
  return room.stage.onStage
    .filter((identity) => selected.includes(identity) || sharing(identity))
    .map((identity) => {
      const checked = selected.includes(identity)
      return {
        identity,
        label: nameOf(identity),
        checked,
        disabledReason: checked || !full ? null : TWO_SCREENS_AT_MOST
      }
    })
}

/** The stage after a row is ticked or unticked. */
export function toggleStageScreen(
  stage: CloudStage,
  identity: string,
  checked: boolean,
  max: number
): CloudStage {
  const current = programScreens(stage)
  if (!checked) return current.includes(identity) ? removeScreen(stage, identity) : stage
  if (current.includes(identity)) return stage
  if (max <= 1) return showScreens(stage, [identity], max)
  if (current.length >= max) return stage
  return showScreens(stage, [...current, identity], max)
}
