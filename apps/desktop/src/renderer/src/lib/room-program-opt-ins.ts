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
  /** Each output page's acknowledgement: which output applied it. */
  observed?: Record<string, { output: 'stream' | 'recording' }>
}

/** Where an applied opt-in is: only the outputs that confirmed it. */
function appliedLine(optIn: RoomProgramOptIn): string {
  const outputs = new Set(Object.values(optIn.observed ?? {}).map((entry) => entry.output))
  if (outputs.has('stream') && outputs.has('recording')) return 'On the stream and the recording.'
  if (outputs.has('recording')) return 'On the recording.'
  if (outputs.has('stream')) return 'On the stream.'
  return 'On the program.'
}

/** What one opt-in does to the stream now: its refusal reason when it has one. */
function optInStatus(optIn: RoomProgramOptIn | null | undefined): string {
  if (optIn?.reason) return optIn.reason
  if (optIn?.state === 'applied') return appliedLine(optIn)
  if (optIn?.enabled) return 'On. Waiting for the stream to confirm.'
  return 'Not on the stream.'
}

/** The Avatar switch's description in Guests → Room. */
export function roomAvatarDescription(avatar: RoomProgramOptIn | null | undefined): string {
  return optInStatus(avatar)
}

/**
 * The Graphics switch's description in Guests → Room. Captions and comment
 * cards reach the stream with the switch off too (`roomGraphicsContent`), so
 * their delivery never reads as the banners being on.
 */
export function roomGraphicsDescription(graphics: RoomProgramOptIn | null | undefined): string {
  return `Banners, timers and the chat box. ${graphics?.enabled ? optInStatus(graphics) : 'Not on the stream.'}`
}

/** The Program preview's one line: "Avatar off · Graphics off". */
export function roomProgramSummary(
  avatar: RoomProgramOptIn | null | undefined,
  graphics: RoomProgramOptIn | null | undefined
): string {
  return `Avatar ${avatar?.enabled ? 'on' : 'off'} · Graphics ${graphics?.enabled ? 'on' : 'off'}`
}

/** The same two facts as chips on the Program card: each with its state. */
export function roomProgramChips(
  avatar: RoomProgramOptIn | null | undefined,
  graphics: RoomProgramOptIn | null | undefined
): { id: 'avatar' | 'graphics'; label: string; on: boolean }[] {
  return [
    {
      id: 'avatar',
      label: `Avatar ${avatar?.enabled ? 'on' : 'off'}`,
      on: avatar?.enabled === true
    },
    {
      id: 'graphics',
      label: `Graphics ${graphics?.enabled ? 'on' : 'off'}`,
      on: graphics?.enabled === true
    }
  ]
}

/** An opt-in's state as a status dot: applied, waiting, refused or off. */
export function roomOptInTone(
  optIn: RoomProgramOptIn | null | undefined
): 'good' | 'warn' | 'error' | 'neutral' {
  if (!optIn?.enabled) return 'neutral'
  if (optIn.reason) return 'error'
  return optIn.state === 'applied' ? 'good' : 'warn'
}
