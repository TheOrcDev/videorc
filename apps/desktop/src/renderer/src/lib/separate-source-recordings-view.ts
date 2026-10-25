import type { RecordingRole, SessionListItem } from '@/lib/backend'
import { formatTimecode } from '@/lib/format-time'

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

/**
 * Secondary-line note naming the audio TRACK the file carries. The track is
 * always present (silence when that source was off), so this names the track,
 * not a promise that the source was on.
 */
export function recordingRoleRowNote(role: RecordingRole): string {
  switch (role) {
    case 'combined':
      return 'combined take'
    case 'screen':
      return 'screen, system audio track'
    case 'camera':
      return 'camera, microphone track'
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

/**
 * Plan 198: why a take's Screen or Camera file stopped. The reasons are the
 * backend's (`source_iso.rs`: the role supervisor and the commit), matched
 * here so a Library row and a toast say one plain sentence, never the raw
 * text. An MP4 export that failed after a good take matches none of them.
 */
type SeparateFileFailureKind =
  | 'capture'
  | 'encoder'
  | 'writer'
  | 'audio'
  | 'short'
  | 'missing'
  | 'placement'
  | 'ownership'

const SEPARATE_FILE_FAILURES: readonly (readonly [RegExp, SeparateFileFailureKind])[] = [
  [/capture failed after source recovery/i, 'capture'],
  [/encoder failed|encoder writer could not be reaped|encoder teardown failed/i, 'encoder'],
  [/muxer (exited|failed|exceeded)|could not reap .*muxer|recording supervisor failed/i, 'writer'],
  [/audio failed|audio bus ended|audio teardown failed/i, 'audio'],
  [/artifact ended at|artifact duration could not be verified/i, 'short'],
  [/file was missing after stop/i, 'missing'],
  [/could not (bind|publish|persist)/i, 'placement'],
  [/separate recording ownership could not be verified/i, 'ownership']
]

/** Below this, a stopped file holds nothing worth exporting. */
const USABLE_PARTIAL_MS = 1000

type SeparateFileRole = Extract<RecordingRole, 'screen' | 'camera'>

function separateFileFailureKind(error: string | null | undefined): SeparateFileFailureKind | null {
  if (!error) return null
  return SEPARATE_FILE_FAILURES.find(([pattern]) => pattern.test(error))?.[1] ?? null
}

function separateFileFailureSentence(
  kind: SeparateFileFailureKind,
  role: SeparateFileRole | null
): string {
  switch (kind) {
    case 'capture':
      return role === 'camera'
        ? "The camera stopped sending video and couldn't be restarted."
        : "The screen stopped sending video and couldn't be restarted."
    case 'encoder':
      return "Videorc couldn't keep encoding this file."
    case 'writer':
      return "Videorc couldn't keep writing this file."
    case 'audio':
      return "This file's audio stopped."
    case 'short':
      return 'This file ended before the take did.'
    case 'missing':
      return "This file wasn't there when you stopped recording."
    case 'placement':
      return "Videorc couldn't place this file beside your recording."
    case 'ownership':
      return "Videorc couldn't confirm this file after it restarted."
  }
}

/** The role a `separate-source-recordings-role-failed` message names first. */
export function separateFileRoleFromMessage(message: string): SeparateFileRole | null {
  const match = /^(screen|camera)\b/i.exec(message.trim())
  return match ? (match[1].toLowerCase() as SeparateFileRole) : null
}

export type SeparateFileStopped = {
  /** The row's badge: "Stopped early", or "Not saved" when no file is left. */
  label: string
  /** Why, on hover and focus, with what the file kept. */
  detail: string
  /** Long enough to export what it recorded. */
  exportable: boolean
}

/**
 * A Screen or Camera row whose file stopped during the take. Its MKV is what
 * it recorded before it stopped (the backend keeps it for recovery), so the
 * row says "Stopped early" instead of "MP4 failed", and offers the export
 * only when the file holds something.
 */
export function separateFileStopped(
  session: Pick<
    SessionListItem,
    'recordingRole' | 'finalizationState' | 'finalizationError' | 'mp4Path' | 'durationMs'
  >
): SeparateFileStopped | null {
  const role = session.recordingRole
  if (role !== 'screen' && role !== 'camera') return null
  if (session.finalizationState !== 'failed' || session.mp4Path) return null
  const kind = separateFileFailureKind(session.finalizationError)
  if (!kind) return null
  const sentence = separateFileFailureSentence(kind, role)
  if (kind === 'missing' || kind === 'ownership') {
    return { label: 'Not saved', detail: sentence, exportable: false }
  }
  const kept = session.durationMs ?? 0
  const exportable = kept >= USABLE_PARTIAL_MS
  return {
    label: 'Stopped early',
    detail: exportable
      ? `${sentence} The first ${formatTimecode(kept)} is kept.`
      : `${sentence} Nothing usable was recorded before it stopped.`,
    exportable
  }
}

/** Why "Export MP4" is off on a file that stopped before it recorded anything. */
export const SEPARATE_FILE_NOTHING_TO_EXPORT =
  'Nothing usable was recorded before this file stopped.'

/**
 * The Studio's toast when a Screen or Camera file stops (plan 198, D1): one
 * per file per take, a warning, the reason in plain words. While the take
 * runs it says the Combined recording carries on.
 */
export function separateFileFailedToast(
  message: string,
  takeRunning: boolean
): { title: string; description: string } {
  const role = separateFileRoleFromMessage(message)
  const name =
    role === 'camera' ? 'Camera file' : role === 'screen' ? 'Screen file' : 'Separate file'
  const kind = separateFileFailureKind(message)
  const sentence = kind
    ? separateFileFailureSentence(kind, role)
    : "Videorc couldn't finish this file."
  if (takeRunning) {
    return {
      title: `${name} stopped`,
      description: `${sentence} Your Combined recording keeps going.`
    }
  }
  return {
    title:
      kind === 'missing' || kind === 'ownership' ? `${name} wasn't saved` : `${name} stopped early`,
    description: sentence
  }
}
