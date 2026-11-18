/**
 * The room's opt-ins for the program (plan 249 S4, S9): the avatar and the
 * graphics, each off until the streamer turns it on for this room. Their one
 * home is Guests → Room; the Show stage's Program preview only summarises
 * them and links there. Plain words: what the stream gets, never how.
 *
 * Imported only by lazy pages (the Show stage, Guests), so it stays out of
 * the eager bundle.
 */

/** The parts of a room avatar or graphics status these lines read. */
export interface RoomProgramOptIn {
  enabled: boolean
  state?: string | null
  reason?: string | null
}

/** What one opt-in does to the stream now: its refusal reason when it has one. */
function optInStatus(optIn: RoomProgramOptIn | null | undefined): string {
  if (optIn?.reason) return optIn.reason
  if (optIn?.state === 'applied') return 'On the stream and the recording.'
  if (optIn?.enabled) return 'On. Waiting for the stream to confirm.'
  return 'Not on the stream.'
}

/** The Avatar switch's description in Guests → Room. */
export function roomAvatarDescription(avatar: RoomProgramOptIn | null | undefined): string {
  return optInStatus(avatar)
}

/** The Graphics switch's description in Guests → Room. */
export function roomGraphicsDescription(graphics: RoomProgramOptIn | null | undefined): string {
  return `Banners, timers and the chat box. ${optInStatus(graphics)}`
}

/** The Program preview's one line: "Avatar off · Graphics off". */
export function roomProgramSummary(
  avatar: RoomProgramOptIn | null | undefined,
  graphics: RoomProgramOptIn | null | undefined
): string {
  return `Avatar ${avatar?.enabled ? 'on' : 'off'} · Graphics ${graphics?.enabled ? 'on' : 'off'}`
}
