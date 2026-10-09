import goblinIdleUrl from '@/assets/buddy/official/goblin/idle.webp'
import goblinLaughUrl from '@/assets/buddy/official/goblin/laugh.webp'
import goblinTalkUrl from '@/assets/buddy/official/goblin/talk.webp'
import goblinThinkUrl from '@/assets/buddy/official/goblin/think.webp'
import orcIdleUrl from '@/assets/buddy/official/orc/idle.webp'
import orcLaughUrl from '@/assets/buddy/official/orc/laugh.webp'
import orcTalkUrl from '@/assets/buddy/official/orc/talk.webp'
import orcThinkUrl from '@/assets/buddy/official/orc/think.webp'
import pirateIdleUrl from '@/assets/buddy/official/pirate/idle.webp'
import pirateLaughUrl from '@/assets/buddy/official/pirate/laugh.webp'
import pirateTalkUrl from '@/assets/buddy/official/pirate/talk.webp'
import pirateThinkUrl from '@/assets/buddy/official/pirate/think.webp'
import robotIdleUrl from '@/assets/buddy/official/robot/idle.webp'
import robotLaughUrl from '@/assets/buddy/official/robot/laugh.webp'
import robotTalkUrl from '@/assets/buddy/official/robot/talk.webp'
import robotThinkUrl from '@/assets/buddy/official/robot/think.webp'
import { BUDDY_DEFAULT_PACK } from '@/lib/buddy-default-pack'
import type { BuddyOfficialSlug, BuddyPoseState } from '../../../shared/buddy-library'

/**
 * The official characters' bundled poses (plan 170 D10), by slug: the
 * Buddy's are the default pack, the others ship under
 * `assets/buddy/official/<slug>/`. URLs only (each picture is its own file),
 * but import this module only from lazy chunks (the Buddy tab, the
 * onboarding), never from the eager shell.
 */
export const BUDDY_OFFICIAL_ART: Readonly<
  Record<BuddyOfficialSlug, Readonly<Record<BuddyPoseState, string>>>
> = {
  golem: BUDDY_DEFAULT_PACK,
  orc: { idle: orcIdleUrl, talk: orcTalkUrl, laugh: orcLaughUrl, think: orcThinkUrl },
  goblin: {
    idle: goblinIdleUrl,
    talk: goblinTalkUrl,
    laugh: goblinLaughUrl,
    think: goblinThinkUrl
  },
  pirate: {
    idle: pirateIdleUrl,
    talk: pirateTalkUrl,
    laugh: pirateLaughUrl,
    think: pirateThinkUrl
  },
  robot: {
    idle: robotIdleUrl,
    talk: robotTalkUrl,
    laugh: robotLaughUrl,
    think: robotThinkUrl
  }
}
