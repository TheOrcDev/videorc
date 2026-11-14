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
