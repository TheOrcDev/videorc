/**
 * The Stream Manager's own glyphs: what a viewer did for the stream (plan
 * 055) and the stats bar's viewer count (plan 057). A second, window-scoped
 * registry: the shared one (`@/components/icons`) ships in every window's
 * eager chunk, and these seven are only ever drawn in the Stream Manager.
 * They count toward the same licence ceiling (docs/icon-set.md), and
 * `no-restricted-imports` exempts this file only.
 */
import { Coins } from '@phosphor-icons/react/dist/csr/Coins'
import { Gift } from '@phosphor-icons/react/dist/csr/Gift'
import { Megaphone } from '@phosphor-icons/react/dist/csr/Megaphone'
import { Star } from '@phosphor-icons/react/dist/csr/Star'
import { User } from '@phosphor-icons/react/dist/csr/User'
import { UserPlus } from '@phosphor-icons/react/dist/csr/UserPlus'
import { UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree'

import type { AppIcon } from '@/components/icons'

export const FollowIcon: AppIcon = UserPlus
export const SupporterIcon: AppIcon = Star
export const GiftIcon: AppIcon = Gift
export const TipIcon: AppIcon = Coins
export const RaidIcon: AppIcon = UsersThree
export const AnnouncementIcon: AppIcon = Megaphone
export const ViewersIcon: AppIcon = User
