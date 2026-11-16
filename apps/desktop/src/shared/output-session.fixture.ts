import type { CloudStatus, RecordingStatus } from './backend'
export const idleNative: RecordingStatus = { state: 'idle' }
export function cloudRoom(recording = false, live = false): CloudStatus {
  return {
    phase: 'live',
    entitled: true,
    settings: { enabled: true, holdMaxSeconds: 1800, holdMaxChoices: [300] },
    show: { id: 'show-1', nodeId: 'managed', resumable: false, kind: 'talk' },
    connected: true,
    directFallbackAvailable: false,
    room: {
      phase: 'open',
      doorOpen: false,
      declinedCount: 0,
      stage: { layout: 'solo', onStage: [] },
      hostAway: false,
      connected: true,
      client: 'connected',
      returnEnabled: false,
      stageSet: true,
      live,
      ...(live ? { liveSince: '2026-11-16T12:00:00Z' } : {})
    },
    recording: { active: recording, seconds: 0, bytes: 0 }
  }
}
