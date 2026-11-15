// The Avatar page (plan 239): pure derivations of what the studio provider
// already holds, so the page and its tests cannot disagree.

export type AvatarPlacementKind = 'both' | 'stream' | 'recording' | 'off'

export interface AvatarPlacementView {
  kind: AvatarPlacementKind
  /** The status row's words: where viewers see the avatar. */
  label: string
  /** The dot's tone: success while viewers see it, neutral otherwise. */
  tone: 'tone-success' | 'tone-neutral'
}

const PLACEMENT_LABELS: Record<AvatarPlacementKind, string> = {
  both: 'On stream and in recordings',
  stream: 'On stream, not in recordings',
  recording: 'In recordings, not on stream',
  off: 'Not on stream or in recordings'
}

/**
 * Where the avatar shows, from the overlay item's two switches (the Scene
 * canvas's "Show on stream" and "Show in recording"; the Stream Manager's
 * "{name} on stream" is the first). The status row says it; the switches
 * keep their homes, so the row never holds a third copy of them.
 */
export function avatarPlacementView(item: {
  showOnStream: boolean
  showInRecording: boolean
}): AvatarPlacementView {
  const kind: AvatarPlacementKind =
    item.showOnStream && item.showInRecording
      ? 'both'
      : item.showOnStream
        ? 'stream'
        : item.showInRecording
          ? 'recording'
          : 'off'
  return {
    kind,
    label: PLACEMENT_LABELS[kind],
    tone: item.showOnStream ? 'tone-success' : 'tone-neutral'
  }
}
