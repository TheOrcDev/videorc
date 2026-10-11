import type { WsStatus } from '@/lib/capture'

// Plan 174 S2.3a (B-22): why Record and Go Live wait, in the streamer's
// words. A module of its own because the Studio provider loads it eagerly;
// `lib/state-labels.ts` re-exports it with the other state words.

/**
 * Why Record and Go Live wait while Videorc's engine is not connected (B-22),
 * or null when it is. Never "Backend socket is closed."
 */
export function connectionBlockedReason(wsStatus: WsStatus): string | null {
  switch (wsStatus) {
    case 'connected':
      return null
    case 'waiting':
    case 'connecting':
      return "Starting Videorc's capture engine…"
    default:
      return 'Videorc is reconnecting. Try again in a moment.'
  }
}

/** The start-blocking copy table (B-22): what to do next, in the streamer's words. */
export const START_BLOCKED_COPY = {
  sessionRunning: 'A recording or livestream is already running.',
  noOutput: 'Turn on Save local recording in Output, or go live.',
  destinationSetup: 'Finish setting up your destination in Livestream before you go live.',
  noDestination: 'Turn on a destination in Livestream before you go live.',
  checkingRecorder: 'Checking the recorder…',
  recorderMissing: "Videorc's recorder isn't available. Export a support bundle from Health."
} as const
