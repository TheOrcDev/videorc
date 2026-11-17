import { isActiveRecordingState, type MainCaptureState } from '../shared/capture-state'
import type { CloudRoomActivity } from '../shared/cloud-room-activity'

export {
  cloudRoomActivityFromCloudStatus,
  type CloudRoomActivity
} from '../shared/cloud-room-activity'

/**
 * The capture state the guards read: the local session's, or the room's
 * activity in its words when the local session is idle. An unknown state
 * stays unknown (the guards already fail closed on it), and an active local
 * session is never downgraded.
 */
export function guardCaptureState(
  capture: MainCaptureState,
  room: CloudRoomActivity
): MainCaptureState {
  if (capture === 'unknown' || room === null) return capture
  if (isActiveRecordingState(capture)) return capture
  return room === 'live' ? 'streaming' : 'recording'
}
