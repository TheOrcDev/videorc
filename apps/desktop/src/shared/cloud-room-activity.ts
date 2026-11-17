/**
 * Plan 249 S26: the live activity every app lifecycle guard reads. A cloud
 * room has no local session, so `recording.status` alone calls the app idle
 * while this computer's room is on air or recording. Updating, restarting
 * the backend for a permission, or letting the display sleep would cut that
 * room (its camera, microphone and program contributions live here), so
 * those guards read the room as live activity too.
 *
 * `live`: the room is open, on air, and this computer is the one on air (no
 * hand-off or takeover reported, and `onAir`, when the web sends it, names
 * this computer with no wait). `recording`: the same room, not on air, with
 * the cloud recording running. Read field by field: main never trusts more
 * of the status. Pure: no Electron.
 */
export type CloudRoomActivity = 'live' | 'recording' | null

export function cloudRoomActivityFromCloudStatus(payload: unknown): CloudRoomActivity {
  if (!payload || typeof payload !== 'object') return null
  const status = payload as {
    room?: { phase?: unknown; live?: unknown } | null
    onAir?: { thisDevice?: unknown; waiting?: unknown } | null
    stoppedBy?: unknown
    recording?: { active?: unknown } | null
  }
  const onAir = status.onAir
  if (
    status.room?.phase !== 'open' ||
    status.stoppedBy !== undefined ||
    !(onAir === undefined || (onAir?.thisDevice === true && onAir.waiting !== true))
  ) {
    return null
  }
  if (status.room.live === true) return 'live'
  if (status.recording?.active === true) return 'recording'
  return null
}
