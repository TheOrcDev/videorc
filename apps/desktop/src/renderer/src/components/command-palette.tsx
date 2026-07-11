import {
  ChatCircle,
  ClosedCaptioning,
  Desktop,
  Moon,
  Stop,
  Sun,
  VideoCamera
} from '@phosphor-icons/react'
import { useTheme } from 'next-themes'
import type { ReactElement } from 'react'

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { displayKeyGlyph } from '@/lib/platform'
import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  shortcutDigitFor,
  useWorkspaceNav
} from '@/components/workspace-nav'
import { useStudioCore, useStudioRecordingState } from '@/hooks/use-studio'

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
  const {
    runtimeInfo,
    startSession,
    stopSession,
    commentsWindow,
    toggleCommentsWindow,
    captionsWindow,
    toggleCaptionsWindow
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)
  const { setTheme } = useTheme()

  const run = (action: () => void | Promise<void>): void => {
    onOpenChange(false)
    void action()
  }

  const live = recording.state === 'recording' || recording.state === 'streaming'
  const busy = recording.state === 'starting' || recording.state === 'stopping'

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Go to">
          {WORKSPACE_TABS.map((tab) => {
            const digit = shortcutDigitFor(tab.id)
            return (
              <CommandItem
                key={tab.id}
                value={`Go to ${tab.label}`}
                onSelect={() => run(() => setActive(tab.id))}
              >
                <tab.icon className="size-4" />
                {tab.label}
                {digit ? (
                  <CommandShortcut className="tracking-normal">
                    <Kbd>
                      {modKey}
                      {digit}
                    </Kbd>
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Setup">
          {STUDIO_PANELS.map((panel) => {
            const digit = shortcutDigitFor(panel.id)
            return (
              <CommandItem
                key={panel.id}
                value={`Open ${panel.label}`}
                onSelect={() => run(() => openStudioPanel(panel.id))}
              >
                <panel.icon className="size-4" />
                {panel.label}
                {digit ? (
                  <CommandShortcut className="tracking-normal">
                    <Kbd>
                      {modKey}
                      {digit}
                    </Kbd>
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Session">
          {live ? (
            <CommandItem
              value="Stop session"
              disabled={busy}
              onSelect={() => run(() => void stopSession())}
            >
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
          {runtimeInfo?.commentsWindowEnabled ? (
            <CommandItem
              value="Toggle comments window"
              onSelect={() => run(() => toggleCommentsWindow())}
            >
              <ChatCircle className="size-4" />
              {commentsWindow.open ? 'Close comments window' : 'Open comments window'}
              <CommandShortcut className="tracking-normal">
                <Kbd>
                  {modKey}
                  {shiftKey}J
                </Kbd>
              </CommandShortcut>
            </CommandItem>
          ) : null}
          {captionsWindow.enabled || captionsWindow.open ? (
            <CommandItem
              value="Toggle captions reader"
              onSelect={() => run(() => toggleCaptionsWindow())}
            >
              <ClosedCaptioning className="size-4" />
              {captionsWindow.open ? 'Close captions reader' : 'Open captions reader'}
              <CommandShortcut className="tracking-normal">
                <Kbd>
                  {modKey}
                  {shiftKey}C
                </Kbd>
              </CommandShortcut>
            </CommandItem>
          ) : null}
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
