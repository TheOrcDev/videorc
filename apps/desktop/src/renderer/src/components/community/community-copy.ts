import type { CommunitySettings } from '@/lib/backend'

// Know your viewers (plan 225 D10, D12): the settings defaults and the
// words of the lazy Community surfaces only. Kept out of `lib/community-view`
// on purpose: the chat row imports that module into the eager bundle, and
// nothing here is needed before Community, the person card or the offer
// load (the renderer budget is an owner STOP).

/** Rust's defaults (plan 225 Wire shape), for an older backend's settings. */
export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettings = {
  enabled: true,
  regularStreams: 3,
  welcomeOnStream: true,
  milestoneCards: false,
  remember: false,
  rememberOffered: false,
  sync: false
}

/** D10: the one-time offer, after the first stream regulars came to. */
export const REMEMBER_OFFER_TITLE = 'Let Buddy remember what your regulars tell it?'
export const REMEMBER_OFFER_DESCRIPTION =
  'After a stream, Buddy reads what your regulars said about themselves and keeps a few short memories, so next time it can ask how the borrow checker is treating them. You see and delete every memory. YouTube chat is never read for this.'

/** "Forget this memory?": the confirm's title and its one sentence (D10). */
export function memoryForgetCopy(
  name: string,
  text: string
): { title: string; description: string; confirm: string } {
  return {
    title: 'Forget this memory?',
    description: `Buddy stops remembering “${text}” about ${name}. It can learn it again from a later stream.`,
    confirm: 'Forget memory'
  }
}
