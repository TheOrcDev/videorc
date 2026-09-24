/**
 * The Stream Manager's activity glyphs (plan 053): what a viewer did for the
 * stream. A second, window-scoped registry: the shared one (`@/components/icons`)
 * ships in every window's eager chunk, and these six are only ever drawn in
 * the Stream Manager. They count toward the same licence ceiling
 * (docs/icon-set.md), and `no-restricted-imports` exempts this file only.
 */
import { Coins, Gift, Megaphone, Star, UserPlus, UsersThree } from '@phosphor-icons/react'

import type { AppIcon } from '@/components/icons'

export const FollowIcon: AppIcon = UserPlus
export const SupporterIcon: AppIcon = Star
export const GiftIcon: AppIcon = Gift
export const TipIcon: AppIcon = Coins
export const RaidIcon: AppIcon = UsersThree
export const AnnouncementIcon: AppIcon = Megaphone
