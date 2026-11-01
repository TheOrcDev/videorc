'use client'

import { useSyncExternalStore } from 'react'
import type { ComponentProps, ReactElement } from 'react'

import { Kbd } from '@/components/ui/kbd'
import { currentPlatform, shortcutLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'

const subscribe = (): (() => void) => () => {
  // The platform never changes while the page is open: nothing to watch.
}

// A server can't know the reader's platform. It prints the Windows and Linux
// spelling and the client corrects it as it hydrates; a client-only render
// (an Electron window) reads the real platform on its first paint.
const SERVER_PLATFORM = 'other'

function useShortcutPlatform(platform: string | undefined): string {
  return useSyncExternalStore(
    subscribe,
    () => currentPlatform(platform) ?? SERVER_PLATFORM,
    () => platform ?? SERVER_PLATFORM
  )
}

type ShortcutKeysProps = {
  /** An Electron accelerator: `CmdOrCtrl+Shift+J`, `Enter`, `Space`. */
  accelerator: string
  /** `darwin`, `win32`, `linux`…; without one, `data-platform` on <html>, then the user agent. */
  platform?: string
  variant?: 'chip' | 'text'
} & Omit<ComponentProps<'kbd'>, 'children'>

/**
 * The one way to show a shortcut. Takes an Electron accelerator
 * (`CmdOrCtrl+Shift+J`, `Enter`, `Space`) and prints it the way the
 * platform's own menus do: one keycap in system order on macOS (⇧⌘J, ⌘↵,
 * Space), words joined by "+" on Windows and Linux (Ctrl+Shift+J, Ctrl+Enter,
 * Backspace). With no platform it reads the one bootstrap set before the
 * first paint, so a Mac never flashes "Ctrl".
 *
 * `variant="text"` is the status bar's quiet hint: the same label, no keycap.
 */
function ShortcutKeys({
  accelerator,
  platform,
  variant = 'chip',
  className,
  ...props
}: ShortcutKeysProps): ReactElement | null {
  const label = shortcutLabel(accelerator, useShortcutPlatform(platform))
  if (!label) {
    return null
  }
  if (variant === 'text') {
    return (
      <span
        className={cn('font-medium', className)}
        data-accelerator={accelerator}
        data-slot="shortcut-keys"
        {...props}
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

export { ShortcutKeys, type ShortcutKeysProps }
