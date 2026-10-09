import goblinIdleUrl from '@/assets/golem/official/goblin/idle.webp'
import goblinLaughUrl from '@/assets/golem/official/goblin/laugh.webp'
import goblinTalkUrl from '@/assets/golem/official/goblin/talk.webp'
import goblinThinkUrl from '@/assets/golem/official/goblin/think.webp'
import orcIdleUrl from '@/assets/golem/official/orc/idle.webp'
import orcLaughUrl from '@/assets/golem/official/orc/laugh.webp'
import orcTalkUrl from '@/assets/golem/official/orc/talk.webp'
import orcThinkUrl from '@/assets/golem/official/orc/think.webp'
import pirateIdleUrl from '@/assets/golem/official/pirate/idle.webp'
import pirateLaughUrl from '@/assets/golem/official/pirate/laugh.webp'
import pirateTalkUrl from '@/assets/golem/official/pirate/talk.webp'
import pirateThinkUrl from '@/assets/golem/official/pirate/think.webp'
import robotIdleUrl from '@/assets/golem/official/robot/idle.webp'
import robotLaughUrl from '@/assets/golem/official/robot/laugh.webp'
import robotTalkUrl from '@/assets/golem/official/robot/talk.webp'
import robotThinkUrl from '@/assets/golem/official/robot/think.webp'
import { GOLEM_DEFAULT_PACK } from '@/lib/golem-default-pack'
import type { GolemOfficialSlug, GolemPoseState } from '../../../shared/golem-library'

/**
 * The official characters' bundled poses (plan 170 D10), by slug: the
 * Golem's are the default pack, the others ship under
 * `assets/golem/official/<slug>/`. URLs only (each picture is its own file),
 * but import this module only from lazy chunks (the Golem tab, the
 * onboarding), never from the eager shell.
 */
export const GOLEM_OFFICIAL_ART: Readonly<
  Record<GolemOfficialSlug, Readonly<Record<GolemPoseState, string>>>
> = {
  golem: GOLEM_DEFAULT_PACK,
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
