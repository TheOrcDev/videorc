import type { ReactElement } from 'react'

import { CHAT_PLATFORM_LABELS, ChatPlatformIcon } from '@/components/chat-platform-icon'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import { ShortcutTooltip } from '@/components/ui/shortcut-tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { StreamPlatform } from '@/lib/backend'

// The one platform filter for Chat and Activity (plan 174 S3.16a, H-19): an
// All chip and one icon chip per platform from 640 px, the same choice as a
// radio group inside each pane's Filters menu below it. Nothing at all with
// one platform: there is nothing to filter by.

export type PlatformFilterValue = StreamPlatform | 'all'

export function PlatformFilter({
  platforms,
  value,
  onValueChange,
  label
}: {
  platforms: readonly StreamPlatform[]
  value: PlatformFilterValue
  onValueChange: (value: PlatformFilterValue) => void
  /** The group's accessible name: "Show chat from", "Show activity from". */
  label: string
}): ReactElement | null {
  if (platforms.length < 2) return null
  return (
    <ToggleGroup
      aria-label={label}
      value={[value]}
      onValueChange={(next) => onValueChange((next[0] ?? 'all') as PlatformFilterValue)}
    >
      <ToggleGroupItem className="text-xs" value="all">
        All
      </ToggleGroupItem>
      {platforms.map((platform) => (
        <ShortcutTooltip key={platform} label={`Only ${CHAT_PLATFORM_LABELS[platform]}`}>
          <ToggleGroupItem aria-label={CHAT_PLATFORM_LABELS[platform]} value={platform}>
            <ChatPlatformIcon decorative platform={platform} />
          </ToggleGroupItem>
        </ShortcutTooltip>
      ))}
    </ToggleGroup>
  )
}

/** The same choice inside a Filters menu (below 640 px). Nothing with one platform. */
export function PlatformFilterMenuItems({
  platforms,
  value,
  onValueChange,
  label
}: {
  platforms: readonly StreamPlatform[]
  value: PlatformFilterValue
  onValueChange: (value: PlatformFilterValue) => void
  label: string
}): ReactElement | null {
  if (platforms.length < 2) return null
  return (
    <>
      <DropdownMenuLabel>{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(next) => onValueChange(next as PlatformFilterValue)}
      >
        <DropdownMenuRadioItem closeOnClick value="all">
          Every platform
        </DropdownMenuRadioItem>
        {platforms.map((platform) => (
          <DropdownMenuRadioItem key={platform} closeOnClick value={platform}>
            <ChatPlatformIcon decorative platform={platform} />
            {CHAT_PLATFORM_LABELS[platform]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
