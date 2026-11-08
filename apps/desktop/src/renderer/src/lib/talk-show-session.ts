import type { CloudStatus } from '@/lib/backend'

// A talk show as the transport sees it (plan 224 C-G6, D10, D17). Record
// and Go Live stay the same buttons: while the room is open the cloud
// recording and the runner's legs project into the recording-state view
// the transport, the status pill and the clocks already read, so nothing
// next to Record or Go Live changes. Pure, so the projection is a test.

/** The `streamUrl` a live talk show reads as: never a real address. */
export const TALK_SHOW_STREAM_URL = 'videorc-cloud'

export type TalkShowSessionView = {
  /** `streaming` on air (the pill reads "On air"); `recording` for the cloud recording alone. */
  state: 'recording' | 'streaming'
  /** The show id: the live chat and the comment cards key on it. */
  sessionId: string
  streamUrl?: string
  startedAt?: string
}

/**
 * The transport's view of an open room, or null when the room is closed or
 * nothing runs in it. On air wins over the recording: End livestream keeps
 * the room and the recording (D17), so the stop note never says "Your
 * recording stops too."
 */
export function talkShowSessionView(
  status: CloudStatus | null,
  liveStartedAt: string | null
): TalkShowSessionView | null {
  const room = status?.room
  const showId = status?.show?.id
  if (!room || room.phase !== 'open' || !showId) return null
  if (room.live) {
    return {
      state: 'streaming',
      sessionId: showId,
      streamUrl: TALK_SHOW_STREAM_URL,
      ...(liveStartedAt ? { startedAt: liveStartedAt } : {})
    }
  }
  if (status.recording?.active) {
    return {
      state: 'recording',
      sessionId: showId,
      ...(status.recording.since ? { startedAt: status.recording.since } : {})
    }
  }
  return null
}

/**
 * When the show went on air, from the runner's clock, taken once when the
 * room turns live so the transport's clock does not jitter with every
 * status tick.
 */
export function talkShowLiveStartedAt(status: CloudStatus | null, nowMs: number): string {
  const liveSeconds = status?.liveSeconds ?? 0
  return new Date(nowMs - liveSeconds * 1000).toISOString()
}

/** Record while the room is open means the cloud recording (D10). */
export const RECORDING_GOES_TO_CLOUD = 'Recording goes to Videorc Cloud while the room is open.'

/** The Program monitor before the return arrives (D7): the runner's return
 * may be invisible under a hidden runner token; the monitor never fails. */
export const PROGRAM_MONITOR_EMPTY = 'Program appears when the show starts.'

/**
 * Why Record cannot start a cloud recording, from the runner's
 * `recording.problem` (the wire notes: `no-target`, `bad-target: …`,
 * `credentials-expired`, `upload-failed`); null when it can.
 */
export function talkShowRecordingBlockedReason(status: CloudStatus | null): string | null {
  const problem = status?.recording?.problem
  if (!problem || status?.room?.phase !== 'open') return null
  if (problem === 'no-target' || problem.startsWith('bad-target')) {
    return "Cloud recordings aren't set up for this show."
  }
  if (problem === 'credentials-expired') {
    return 'The cloud recording stopped: its storage access expired.'
  }
  if (problem === 'upload-failed') {
    return "The cloud recording stopped: the upload didn't go through."
  }
  return `The cloud recording isn't available (${problem}).`
}
