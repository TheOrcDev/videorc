/**
 * The room's switches for the program (plan 249 S4, S9) in Guests → Room: the
 * graphics, off until the streamer turns them on for this room, and the
 * avatar, on in every room so it follows its own "on stream" switch (off
 * here hides it for this room only). The Show stage's Program preview only
 * summarises them and links there. Plain words: what the stream gets, never how.
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

/**
 * The room lets the avatar through, but its own switches keep it off every
 * output ("on stream" in Stream Manager, Show on stream and Show in recording
 * on Scene), or no avatar is worn: the publisher's `off`.
 */
function avatarOffByItsOwnSwitch(avatar: RoomProgramOptIn | null | undefined): boolean {
  return avatar?.enabled === true && avatar.state === 'off' && !avatar.reason
}

/** Whether the avatar is headed for the program: let through here and on by its own switch. */
function avatarOn(avatar: RoomProgramOptIn | null | undefined): boolean {
  return avatar?.enabled === true && !avatarOffByItsOwnSwitch(avatar)
}

/**
 * The Avatar switch's description in Guests → Room. The switch starts on, so
 * an avatar that is off by its own switch says where that switch is.
 */
export function roomAvatarDescription(avatar: RoomProgramOptIn | null | undefined): string {
  if (avatarOffByItsOwnSwitch(avatar))
    return 'Your avatar is off. Turn on its “on stream” switch in Stream Manager.'
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
  return `Avatar ${avatarOn(avatar) ? 'on' : 'off'} · Graphics ${graphics?.enabled ? 'on' : 'off'}`
}

/** The same two facts as chips on the Program card: each with its state. */
export function roomProgramChips(
  avatar: RoomProgramOptIn | null | undefined,
  graphics: RoomProgramOptIn | null | undefined
): { id: 'avatar' | 'graphics'; label: string; on: boolean }[] {
  return [
    {
      id: 'avatar',
      label: `Avatar ${avatarOn(avatar) ? 'on' : 'off'}`,
      on: avatarOn(avatar)
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
  // On here, off by its own switch (the avatar): nothing is waiting.
  if (optIn.state === 'off') return 'neutral'
  return optIn.state === 'applied' ? 'good' : 'warn'
}
