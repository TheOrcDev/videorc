import { BANNER_ACTION_COPY } from '@/lib/banners'
import { SOUND_ACTION_COPY } from '@/lib/sounds'

/**
 * What a phone or a deck reads when Videorc refuses a key (plan 174 I-11), and
 * what an agent reads from the same executors (plan 209). Phones and decks
 * show these words as they are, so they are plain copy (docs/ui-copy.md): no
 * ids, no "session", one next step.
 */
export const REMOTE_INTENT_COPY = {
  alreadyRunning: "You're already recording or live.",
  recordDidNotStart: "Recording didn't start. Check Studio on your computer.",
  notRunning: "You're not recording or live.",
  didNotStop: "Couldn't stop. Check Studio on your computer.",
  toggleFailed: "That didn't work. Check Studio on your computer.",
  streamNotSetUp: 'Use Go Live… on your computer first.',
  streamDidNotStart: "The livestream didn't start. Finish going live on your computer.",
  microphone: "Couldn't change the microphone.",
  systemAudio: "System audio isn't available.",
  sceneMissing: "That scene isn't available anymore.",
  sceneFailed: "Couldn't switch the scene.",
  takeoverMissing: "That takeover isn't available anymore.",
  takeoverShow: "Couldn't show the takeover.",
  takeoverHide: "Couldn't hide the takeover.",
  bannerMissing: BANNER_ACTION_COPY.missing,
  bannerShow: BANNER_ACTION_COPY.show,
  bannerHide: BANNER_ACTION_COPY.hide,
  bannersHide: BANNER_ACTION_COPY.hideAll,
  soundMissing: SOUND_ACTION_COPY.missing,
  windowMissing: "That window isn't available.",
  messageMissing: 'Choose a message to put on stream.',
  clipsOff: "Clips are off, and you're not recording or live.",
  unsupported: "This version of Videorc can't do that. Update Videorc.",
  failed: 'Something went wrong. Check Studio on your computer.'
} as const
