import { Desktop, Gauge, Moon, Stop, Sun, VideoCamera } from '@phosphor-icons/react'
import { useTheme } from 'next-themes'
import type { ReactElement } from 'react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { STUDIO_PANELS, WORKSPACE_TABS, useWorkspaceNav } from '@/components/workspace-nav'
import { useStudio } from '@/hooks/use-studio'

/** ⌘K command palette: jump anywhere + run the core session/theme actions. Open state is
 *  owned by the shell so the sidebar trigger and the global shortcut share it. */
export function CommandPalette({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { setActive, openStudioPanel } = useWorkspaceNav()
  const { recording, startSession, stopSession } = useStudio()
  const { setTheme } = useTheme()

  const run = (action: () => void): void => {
    onOpenChange(false)
    action()
  }

  const live = recording.state === 'recording' || recording.state === 'streaming'
  const busy = recording.state === 'starting' || recording.state === 'stopping'

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Go to">
          {WORKSPACE_TABS.map((tab) => (
            <CommandItem
              key={tab.id}
              value={`Go to ${tab.label}`}
              onSelect={() => run(() => setActive(tab.id))}
            >
              <tab.icon className="size-4" />
              {tab.label}
            </CommandItem>
          ))}
          <CommandItem value="Go to Diagnostics" onSelect={() => run(() => setActive('diagnostics'))}>
            <Gauge className="size-4" />
            Diagnostics
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Studio panels">
          {STUDIO_PANELS.map((panel) => (
            <CommandItem
              key={panel.id}
              value={`Open ${panel.label} panel`}
              onSelect={() => run(() => openStudioPanel(panel.id))}
            >
              <panel.icon className="size-4" />
              {panel.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Session">
          {live ? (
            <CommandItem value="Stop session" disabled={busy} onSelect={() => run(() => void stopSession())}>
              <Stop className="size-4" />
              Stop session
            </CommandItem>
          ) : (
            <CommandItem
              value="Start session recording"
              disabled={busy}
              onSelect={() => run(() => void startSession())}
            >
              <VideoCamera className="size-4" />
              Start session
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Theme">
          <CommandItem value="Theme light" onSelect={() => run(() => setTheme('light'))}>
            <Sun className="size-4" />
            Light
          </CommandItem>
          <CommandItem value="Theme dark" onSelect={() => run(() => setTheme('dark'))}>
            <Moon className="size-4" />
            Dark
          </CommandItem>
          <CommandItem value="Theme system" onSelect={() => run(() => setTheme('system'))}>
            <Desktop className="size-4" />
            System
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
