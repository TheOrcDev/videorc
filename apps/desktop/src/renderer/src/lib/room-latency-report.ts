import type { CloudRoomLatencyReport } from '../../../shared/backend'
import type { RoomLatency } from '../../../shared/room-latency'

// Plan 253 S7: what the room client hands the backend after each 10 s
// sample, for the show's record (docs/cloud/253-latency-contract.md,
// section 10). It lives in the room client's lazy chunk. Durations only: a
// figure that could not be measured is left out, never sent as null, and
// with nothing measured there is no report at all.

const NAME_MAX_CHARS = 80
const PEOPLE_MAX = 16

export function roomLatencyReport(
  showId: string,
  latency: RoomLatency,
  nameOf: (identity: string) => string | undefined
): CloudRoomLatencyReport | null {
  const people = Object.entries(latency.people)
    .slice(0, PEOPLE_MAX)
    .map(([identity, delay]) => {
      const name = nameOf(identity)?.trim().slice(0, NAME_MAX_CHARS)
      return {
        identity,
        ...(name ? { name } : {}),
        ms: delay.ms,
        partial: delay.partial,
        ...(delay.toGuestMs === null ? {} : { toGuestMs: delay.toGuestMs }),
        ...(delay.fromGuestMs === null ? {} : { fromGuestMs: delay.fromGuestMs }),
        ...(delay.video?.toGuestMs === undefined ? {} : { videoToGuestMs: delay.video.toGuestMs }),
        ...(delay.video?.fromGuestMs === undefined
          ? {}
          : { videoFromGuestMs: delay.video.fromGuestMs })
      }
    })
  if (latency.hostRttMs === undefined && people.length === 0 && !latency.program) return null
  return {
    showId,
    ...(latency.hostRttMs === undefined ? {} : { hostRttMs: latency.hostRttMs }),
    people,
    ...(latency.program
      ? {
          program: {
            ms: latency.program.ms,
            ...(latency.program.audioMs === null ? {} : { audioMs: latency.program.audioMs })
          }
        }
      : {})
  }
}
