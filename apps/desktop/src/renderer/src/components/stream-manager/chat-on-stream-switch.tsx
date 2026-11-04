import type { ReactElement } from 'react'

import { Switch } from '@/components/ui/switch'
import { COMPACT_LABEL } from '@/lib/stream-manager-layout'
import { cn } from '@/lib/utils'

/** The switch's one name (plan 215 G, D5), here and in its tests. */
export const CHAT_ON_STREAM_LABEL = 'Chat on stream'

/**
 * Chat on stream (plan 215 G, D5) in the chat pane's filter bar, like the
 * Buddy pane's "{name} on stream": it writes `overlayLayout.chat.showOnStream`
 * through the Studio relay. Placement and Show in recording live on the Scene
 * page (the chat box's home). Below 800 px the word leaves the eye, never the
 * screen reader. Its own chunk, loaded with the pane.
 */
export default function ChatOnStreamSwitch({
  checked,
  onCheckedChange
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}): ReactElement {
  return (
    <label
      className="relative flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground"
      data-slot="chat-on-stream"
    >
      <Switch
        aria-label={CHAT_ON_STREAM_LABEL}
        checked={checked}
        data-testid="chat-on-stream"
        size="sm"
        onCheckedChange={(next) => onCheckedChange(next)}
      />
      <span className={cn(COMPACT_LABEL)}>{CHAT_ON_STREAM_LABEL}</span>
    </label>
  )
}
