import type { CloudRoomStatus, CloudStageLayout, CloudStatus } from '@/lib/backend'
import { planStage, shownScreens, type StageCanvas, type StageInput } from '@/lib/talk-show-layout'
import {
  VIEW_SOURCE,
  programPreviewStage,
  type ProgramPreviewStage
} from '../../../shared/cloud-presentation-views'

// What differs on a managed talk show (plan 234 T3): its media runs on
// LiveKit Cloud, with no node of ours, so there is no runner to take an
// overlay and no return picture to watch. Pure, so each rule is a test.
//
// Only the lazy room chunks import this module (the Show stage, the room
// hook, the overlay sender): a solo show or a node talk show never loads it
// before a room opens, and it stays out of the eager renderer bundle.

/**
 * `show.nodeId` of a show on managed media (plan 234): its media runs on
 * LiveKit Cloud, with no node of ours. The web's own marker (wire contract,
 * section 1), pinned to `protocol-fixtures/cloud-managed-wire.json`.
 */
export const MANAGED_NODE_ID = 'livekit'

/** The show is on managed media: no runner, so no return picture. */
export function isManagedShow(status: CloudStatus | null | undefined): boolean {
  return status?.show?.nodeId === MANAGED_NODE_ID
}

/**
 * What the Program monitor shows (plan 234 D6). A node show's runner sends
 * its return, what the cloud really sends. A managed show has none, so its
 * monitor draws the Show stage as the program page reports drawing it
 * (`room.shown`), in the same frame and with the same words:
 *
 * - `empty`: nothing is on air or recording yet;
 * - `waiting`: the show runs, and no program page has reported a stage yet;
 * - `shown`: the stage, as the page draws it.
 */
export type ProgramMonitorView =
  | { source: 'return' }
  | { source: 'stage'; state: 'empty' | 'waiting' | 'shown' }

export function programMonitorView(status: CloudStatus | null | undefined): ProgramMonitorView {
  if (!isManagedShow(status)) return { source: 'return' }
  const running = Boolean(status?.room?.live || status?.recording?.active)
  if (!running) return { source: 'stage', state: 'empty' }
  return { source: 'stage', state: status?.room?.shown ? 'shown' : 'waiting' }
}

const LAYOUTS: readonly CloudStageLayout[] = ['solo', 'side-by-side', 'screen-people', 'spotlight']

/** The layout the page reports drawing, when it is one this desktop knows. */
export function shownLayout(room: CloudRoomStatus | undefined): CloudStageLayout | null {
  const layout = room?.shown?.layout
  // Plan 251: the page draws `two-screens` for a Screen + people stage that
  // names two; the plan takes the two from `screens`.
  if (layout === 'two-screens') return 'screen-people'
  return LAYOUTS.find((known) => known === layout) ?? null
}

/** The managed Program is the page's confirmed projection. Never keep an
 * optimistic stage identity after it disappears from the room. Plan 249 S6:
 * the layout is the one the page drew, when it says so; an older page does
 * not, and the sent layout stands in (its stage is then unconfirmed). */
export function managedProgramStageInput(room: CloudRoomStatus | undefined): StageInput {
  const members = new Set((room?.participants ?? []).map((participant) => participant.identity))
  const people = (room?.shown?.onStage ?? []).filter((identity) => members.has(identity))
  const spotlight = room?.stage.spotlight
  const screens = (room?.shown ? shownScreens(room.shown) : []).filter((identity) =>
    members.has(identity)
  )
  return {
    layout: shownLayout(room) ?? room?.stage.layout ?? 'solo',
    people,
    spotlight: spotlight && people.includes(spotlight) ? spotlight : null,
    screen: screens[0] ?? null,
    ...(screens.length === 2 ? { screens } : {})
  }
}

/**
 * Plan 249 S6: whether the Program preview draws the stage this desktop
 * sent, as the program page itself reports it. Pure; `now` is passed in.
 */
export function managedProgramPreview(
  status: CloudStatus | null | undefined,
  now: number
): ProgramPreviewStage {
  const room = status?.room
  return programPreviewStage({
    running: Boolean(room?.live || status?.recording?.active),
    sent: room?.stage,
    shown: room?.shown,
    now
  })
}

/** Words for the preview's state: short, and never "on air". */
export const PROGRAM_PREVIEW_COPY: Record<
  ProgramPreviewStage['state'],
  { badge: string | null; detail: string }
> = {
  empty: { badge: null, detail: 'Nothing is live or recording yet.' },
  waiting: { badge: null, detail: 'Waiting for the program page to report its stage.' },
  applied: {
    badge: 'Confirmed',
    detail: 'The program page reports drawing this stage. This preview is redrawn here.'
  },
  updating: {
    badge: 'Updating',
    detail: 'The program page still draws an earlier stage. Your change is on its way.'
  },
  unconfirmed: {
    badge: 'Unconfirmed',
    detail: "The program page didn't say which stage it drew. This preview may differ."
  },
  stale: {
    badge: 'Out of date',
    detail: 'The program page has not reported for a while. This preview may be old.'
  }
}

/**
 * Plan 249 S6 (D4): what the guest row under the Program preview says. A
 * guest page counts once it can draw the layers, and as confirmed once it
 * reports the revision it was sent. Never a claim about encoded output.
 */
export function guestGraphicsLine(
  guests: { enabled: boolean; capable: number; applied: number } | undefined,
  output: 'stream' | 'recording' | null
): string {
  if (!guests?.enabled) return "Guests don't see the avatar"
  if (output === 'recording') return 'Recording only · Guests see nothing'
  if (!guests.capable) return 'Shown to guests · No guest page confirmed'
  if (guests.applied === guests.capable) return 'Guests see the avatar'
  return `Shown to guests · ${guests.applied} of ${guests.capable} confirmed`
}

/** Plan 249 S6: the agents' view of the program, by allowlist. No
 * identities or names: roles and geometry only. Never encoded output. */
export type AgentRoomProgram = {
  source: string
  encodedOutput: false
  stage: ProgramPreviewStage['state']
  ageSeconds: number | null
  layout: CloudStageLayout
  screenShared: boolean
  tiles: {
    kind: 'person' | 'screen'
    role: 'host' | 'guest'
    rect: { x: number; y: number; w: number; h: number }
  }[]
}

export function agentRoomProgram(
  status: CloudStatus | null | undefined,
  hostIdentity: string | null,
  canvas: StageCanvas,
  now: number
): AgentRoomProgram | undefined {
  if (!isManagedShow(status) || !status?.room) return undefined
  const preview = managedProgramPreview(status, now)
  const input = managedProgramStageInput(status.room)
  const plan = planStage(canvas, input)
  const round = (value: number): number => Math.round(value * 10_000) / 10_000
  return {
    source: VIEW_SOURCE['program-preview'],
    encodedOutput: false,
    stage: preview.state,
    ageSeconds: preview.ageMs === null ? null : Math.round(preview.ageMs / 1000),
    layout: input.layout,
    screenShared: plan.tiles.some((tile) => tile.kind === 'screen'),
    tiles:
      preview.state === 'empty' || preview.state === 'waiting'
        ? []
        : plan.tiles.map((tile) => ({
            kind: tile.kind,
            role: tile.identity === hostIdentity ? 'host' : 'guest',
            rect: {
              x: round(tile.rect.x / canvas.width),
              y: round(tile.rect.y / canvas.height),
              w: round(tile.rect.w / canvas.width),
              h: round(tile.rect.h / canvas.height)
            }
          }))
  }
}
