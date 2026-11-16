import type { CloudStatus, RecordingStatus } from './backend'
import { sessionIsLive, sessionOwnsTransport } from './capture-state'

/** Output ownership is separate from native capture. Unknown identities stay
 * null until their owning protocol supplies them; a timestamp is not an epoch. */
export interface OutputSessionFacts {
  owner: 'native' | 'cloud-room'
  activity:
    | 'idle'
    | 'room'
    | 'recording'
    | 'live'
    | 'recording-and-live'
    | 'starting'
    | 'stopping'
    | 'failed'
  freshness: 'fresh' | 'stale'
  roomOpen: boolean
  recording: boolean
  live: boolean
  showId: string | null
  nativeSessionId: string | null
  publisherEpoch: string | null
  liveIntervalId: string | null
  recordingTakeId: string | null
  clock: {
    origin: 'native-session' | 'cloud-owner'
    liveSince: string | null
    recordingSince: string | null
  }
  microphoneMuted: boolean | null
  cameraOff: boolean | null
  destinations: { id: string; platform: string; label: string; state: string }[] | null
  effectiveProfiles: null
  terminalReason: string | null
  capabilities: { independentStops: boolean; microphone: boolean; camera: boolean }
}

/** Only known lifecycle codes cross observer boundaries, never server error text. */
function terminalReason(reason: string | undefined): string | null {
  return reason &&
    [
      'host-ended',
      'ended-by-host',
      'show-gone',
      'node-unreachable',
      'hold-limit',
      'media-lost',
      'handover-failed',
      'max-show'
    ].includes(reason)
    ? reason
    : null
}

export function outputSessionFacts(
  native: RecordingStatus,
  cloud: CloudStatus | null,
  connected: boolean,
  media?: {
    identity?: string | null
    state: string
    local: { micMuted: boolean; cameraOff: boolean; microphone: unknown }
  }
): OutputSessionFacts {
  const roomOpen = !!cloud?.room && cloud.room.phase !== 'closed'
  const cloudOwner = roomOpen
  const recording = cloudOwner
    ? cloud?.recording?.active === true
    : sessionOwnsTransport(native) && native.state === 'recording'
  const live = cloudOwner ? cloud?.room?.live === true : !native.replayOnly && sessionIsLive(native)
  const fresh = connected && (!cloudOwner || cloud?.connected === true)
  const mediaFresh =
    fresh &&
    !!cloud?.show?.id &&
    media?.state === 'connected' &&
    media.identity === `host:${cloud?.show?.id}`
  return {
    owner: cloudOwner ? 'cloud-room' : 'native',
    activity:
      !cloudOwner &&
      !native.replayOnly &&
      (native.state === 'starting' || native.state === 'stopping' || native.state === 'failed')
        ? native.state
        : recording && live
          ? 'recording-and-live'
          : live
            ? 'live'
            : recording
              ? 'recording'
              : roomOpen
                ? 'room'
                : 'idle',
    freshness: fresh ? 'fresh' : 'stale',
    roomOpen,
    recording,
    live,
    showId: cloudOwner ? (cloud?.show?.id ?? null) : null,
    nativeSessionId: cloudOwner ? null : (native.sessionId ?? null),
    publisherEpoch: null,
    liveIntervalId: null,
    recordingTakeId: null,
    clock: {
      origin: cloudOwner ? 'cloud-owner' : 'native-session',
      liveSince: cloudOwner
        ? (cloud?.room?.liveSince ?? null)
        : live
          ? (native.startedAt ?? null)
          : null,
      recordingSince: cloudOwner
        ? (cloud?.recording?.since ?? null)
        : recording
          ? (native.startedAt ?? null)
          : null
    },
    microphoneMuted: cloudOwner && mediaFresh ? media!.local.micMuted : null,
    cameraOff: cloudOwner && mediaFresh ? media!.local.cameraOff : null,
    destinations: cloudOwner
      ? (cloud?.legs ?? []).map((t) => ({
          id: t.targetId,
          platform: t.platform,
          label: t.label,
          state: t.state
        }))
      : null,
    effectiveProfiles: null,
    terminalReason: cloudOwner
      ? terminalReason(cloud?.endReason)
      : native.state === 'failed'
        ? 'native-session-failed'
        : null,
    capabilities: {
      independentStops: cloudOwner,
      microphone: cloudOwner ? !!(mediaFresh && media?.local.microphone) : fresh,
      camera: cloudOwner ? !!mediaFresh : fresh
    }
  }
}
