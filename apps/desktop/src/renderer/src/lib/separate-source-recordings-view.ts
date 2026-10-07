import type { RecordingRole, SessionListItem } from '@/lib/backend'

/** Library badge for one file of a separate-source take (plan 157). */
export function recordingRoleLabel(role: RecordingRole): string {
  switch (role) {
    case 'combined':
      return 'Combined'
    case 'screen':
      return 'Screen'
    case 'camera':
      return 'Camera'
  }
}

/** Secondary-line note explaining which audio the file carries. */
export function recordingRoleRowNote(role: RecordingRole): string {
  switch (role) {
    case 'combined':
      return 'combined take'
    case 'screen':
      return 'screen + system audio'
    case 'camera':
      return 'camera + microphone'
  }
}

/** The other rows of the same take, in Combined → Screen → Camera order. */
export function takeSiblings(
  session: Pick<SessionListItem, 'id' | 'takeId'>,
  sessions: readonly Pick<SessionListItem, 'id' | 'takeId' | 'recordingRole'>[]
): Pick<SessionListItem, 'id' | 'takeId' | 'recordingRole'>[] {
  if (!session.takeId) return []
  const order: Record<RecordingRole, number> = { combined: 0, screen: 1, camera: 2 }
  return sessions
    .filter((candidate) => candidate.takeId === session.takeId && candidate.id !== session.id)
    .sort(
      (left, right) =>
        (left.recordingRole ? order[left.recordingRole] : 3) -
        (right.recordingRole ? order[right.recordingRole] : 3)
    )
}
