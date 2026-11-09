import type {
  CloudGuestAction,
  CloudGuestDecision,
  CloudRoomOpenParams,
  CloudStage,
  CloudStageLayout,
  CloudStatus,
  TalkShowDisplaySource
} from '@/lib/backend'
import type { TalkShowRoomSnapshot } from '@/lib/talk-show-room'

// The talk show's context value (plan 224 C-G4), without the controller.
// The Studio provider is in the eager bundle, so it holds only this idle
// value; the controller (`hooks/use-talk-show-room.ts`) mounts lazily under
// the provider (`components/studio/talk-show-room-host.tsx`) and hands its
// value up, and `livekit-client` loads only when a room opens.

/** A frozen idle snapshot, so the UI never waits on the lazy module. */
export const IDLE_TALK_SHOW_SNAPSHOT: TalkShowRoomSnapshot = {
  state: 'idle',
  detail: null,
  identity: null,
  people: [],
  local: {
    camera: null,
    microphone: null,
    screen: null,
    micMuted: false,
    cameraOff: false,
    problem: null
  },
  monitor: { enabled: false, video: null, audio: null }
}

export interface TalkShowContextValue {
  /** The renderer's room connection and its tracks; idle outside a room. */
  room: TalkShowRoomSnapshot
  /**
   * Plan 224 D7 (C-G5): the Show stage replaces the Preview. True while the
   * room is open (and under the lifecycle probe's scripted room).
   */
  previewReplaced: boolean
  /** `host:<showId>` while the room is open, for "You" on the stage. */
  hostIdentity: string | null
  openRoom: (
    params: Omit<CloudRoomOpenParams, 'outputs'> & { outputs?: CloudRoomOpenParams['outputs'] }
  ) => Promise<void>
  closeRoom: () => Promise<void>
  resumeRoom: () => Promise<void>
  rotateInvite: () => Promise<void>
  setDoor: (open: boolean) => Promise<void>
  decideGuest: (requestId: string, decision: CloudGuestDecision) => Promise<void>
  actOnGuest: (guestId: string, action: CloudGuestAction, name?: string) => Promise<void>
  /** The whole stage in one frame (D8). */
  setStage: (stage: CloudStage) => Promise<void>
  bringOn: (identity: string) => Promise<void>
  sendBackstage: (identity: string) => Promise<void>
  setLayout: (layout: CloudStageLayout) => Promise<void>
  setSpotlight: (identity: string | null) => Promise<void>
  /** The screens and windows main's `desktopCapturer` lists, with thumbnails. */
  listDisplaySources: () => Promise<TalkShowDisplaySource[]>
  startScreenShare: (sourceId: string) => Promise<void>
  stopScreenShare: () => Promise<void>
  setMonitor: (enabled: boolean) => Promise<void>
  setMicrophoneMuted: (muted: boolean) => Promise<void>
  setCameraOff: (off: boolean) => Promise<void>
  /** Record in a talk show (D10). */
  startCloudRecording: () => Promise<void>
  stopCloudRecording: () => Promise<void>
  /** End livestream in a talk show (D17): the legs end, the room stays. */
  endTalkShowLivestream: () => Promise<void>
  /** DEV only: a scripted room's status (screenshots and probes, no backend). */
  scriptedCloudStatus?: CloudStatus
}

export const NO_TALK_SHOW: TalkShowContextValue = {
  room: IDLE_TALK_SHOW_SNAPSHOT,
  previewReplaced: false,
  hostIdentity: null,
  openRoom: async () => {},
  closeRoom: async () => {},
  resumeRoom: async () => {},
  rotateInvite: async () => {},
  setDoor: async () => {},
  decideGuest: async () => {},
  actOnGuest: async () => {},
  setStage: async () => {},
  bringOn: async () => {},
  sendBackstage: async () => {},
  setLayout: async () => {},
  setSpotlight: async () => {},
  listDisplaySources: async () => [],
  startScreenShare: async () => {},
  stopScreenShare: async () => {},
  setMonitor: async () => {},
  setMicrophoneMuted: async () => {},
  setCameraOff: async () => {},
  startCloudRecording: async () => {},
  stopCloudRecording: async () => {},
  endTalkShowLivestream: async () => {}
}
