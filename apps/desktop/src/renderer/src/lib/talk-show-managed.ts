import type { CloudStatus } from '@/lib/backend'

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
