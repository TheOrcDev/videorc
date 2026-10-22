import type { ComponentProps, ReactElement } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { shortcutLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'

/**
 * The one way to show a shortcut (plan 174 S1.2, A-5/I-18). Takes an
 * Electron accelerator (`CmdOrCtrl+Shift+J`, `Enter`, `Space`) and prints it
 * the way the platform's own menus do: one keycap in system order on macOS
 * (⇧⌘J, ⌘↵, Space), words joined by "+" on Windows and Linux (Ctrl+Shift+J,
 * Ctrl+Enter, Backspace). With no platform it reads the one bootstrap set
 * before the first paint, so a Mac never flashes "Ctrl".
 *
 * `variant="text"` is the status bar's quiet hint: the same label, no keycap.
 */
export function ShortcutKeys({
  accelerator,
  platform,
  variant = 'chip',
  className,
  ...props
}: {
  accelerator: string
  platform?: string
  variant?: 'chip' | 'text'
} & Omit<ComponentProps<'kbd'>, 'children'>): ReactElement | null {
  const label = shortcutLabel(accelerator, platform)
  if (!label) return null
  if (variant === 'text') {
    return (
      <span
        className={cn('font-medium', className)}
        data-accelerator={accelerator}
        data-slot="shortcut-keys"
      >
        {label}
      </span>
    )
  }
  return (
    <Kbd className={className} data-accelerator={accelerator} {...props}>
      {label}
    </Kbd>
  )
}
