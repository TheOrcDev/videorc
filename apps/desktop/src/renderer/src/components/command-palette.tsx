import {
  CaptionsIcon,
  ChatIcon,
  DarkModeIcon,
  DesktopIcon,
  LightModeIcon,
  LivestreamIcon,
  BuddyIcon,
  RecordIcon,
  SettingsIcon,
  StopIcon
} from '@/components/icons'
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
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { BUDDY_TABS } from '@/lib/buddy-tabs'
import { GO_LIVE_COMMAND, START_RECORDING_COMMAND } from '@/lib/go-live-copy'
import { openLivestreamView } from '@/lib/livestream-tabs'
import { SETTINGS_TABS } from '@/lib/settings-tabs'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { sessionStopControl } from '@/lib/studio-session-view'
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
  const { setActive, openStudioPanel, openSettings, openBuddy } = useWorkspaceNav()
  const {
    runtimeInfo,
    savedScenes,
    applySavedScene,
    startRecording,
    startLivestream,
    requestStopSession,
    commentsWindow,
    toggleCommentsWindow,
    captionsWindow,
    toggleCaptionsWindow
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const platform = runtimeInfo?.platform
  const { setTheme } = useTheme()

  const run = (action: () => void | Promise<void>): void => {
    onOpenChange(false)
    void action()
  }

  const live = recording.state === 'recording' || recording.state === 'streaming'
  const busy = recording.state === 'starting' || recording.state === 'stopping'
  // The transport's own stop words (plan 174 D3): "End livestream" on air,
  // "Stop recording" for a recording.
  const stopLabel = sessionStopControl(recording, false).label

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {savedScenes.length ? (
          <CommandGroup heading="Saved scenes">
            {savedScenes.map((scene) => (
              <CommandItem
                key={scene.id}
                value={`saved-scene-${scene.id}`}
                keywords={[scene.name]}
                onSelect={() =>
                  run(async () => {
                    await applySavedScene(scene.id)
                  })
                }
              >
                {scene.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
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
                    <ShortcutKeys accelerator={`CmdOrCtrl+${digit}`} platform={platform} />
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Setup">
          <CommandItem
            value="Schedule livestream · Upcoming events"
            onSelect={() => run(() => openLivestreamView('upcoming'))}
          >
            Schedule livestream · Upcoming events
          </CommandItem>
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
                    <ShortcutKeys accelerator={`CmdOrCtrl+${digit}`} platform={platform} />
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>

        <CommandSeparator />

        {/* Plan 150: every Buddy tab is one jump away, like Settings'. */}
        <CommandGroup heading="Buddy">
          {BUDDY_TABS.map((tab) => (
            <CommandItem
              key={tab.id}
              value={`Buddy ${tab.label}`}
              onSelect={() => run(() => openBuddy(tab.id))}
            >
              <BuddyIcon className="size-4" />
              {tab.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* Plan 064: every Settings tab is one jump away, so no search field is
            needed inside Settings. */}
        <CommandGroup heading="Settings">
          {SETTINGS_TABS.map((tab) => (
            <CommandItem
              key={tab.id}
              value={`Settings ${tab.label}`}
              onSelect={() => run(() => openSettings(tab.id))}
            >
              <SettingsIcon className="size-4" />
              {tab.label}
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        {/* The transport's two starts and its stop, in its words (plan 174
            D3): "Start recording" and "Go live…", then "Stop recording" or
            "End livestream". */}
        <CommandGroup heading="Session">
          {live ? (
            <CommandItem
              value={stopLabel}
              keywords={['stop', 'end', 'recording', 'livestream']}
              disabled={busy}
              // A livestream asks first (plan 174 S0.1); a recording stops.
              onSelect={() => run(() => void requestStopSession('palette'))}
            >
              <StopIcon className="size-4" />
              {stopLabel}
            </CommandItem>
          ) : (
            <>
              <CommandItem
                value={START_RECORDING_COMMAND}
                keywords={['record']}
                disabled={busy}
                onSelect={() => run(() => void startRecording())}
              >
                <RecordIcon className="size-4" />
                {START_RECORDING_COMMAND}
              </CommandItem>
              <CommandItem
                value={GO_LIVE_COMMAND}
                keywords={['stream', 'livestream', 'broadcast']}
                disabled={busy}
                onSelect={() => run(() => void startLivestream())}
              >
                <LivestreamIcon className="size-4" />
                {GO_LIVE_COMMAND}
              </CommandItem>
            </>
          )}
          {runtimeInfo?.commentsWindowEnabled ? (
            <CommandItem
              value="Toggle Stream Manager chat window"
              onSelect={() => run(() => toggleCommentsWindow())}
            >
              <ChatIcon className="size-4" />
              {commentsWindow.open ? 'Close Stream Manager' : 'Open Stream Manager'}
              <CommandShortcut className="tracking-normal">
                <ShortcutKeys
                  accelerator={shortcutAccelerator('comments-window')}
                  platform={platform}
                />
              </CommandShortcut>
            </CommandItem>
          ) : null}
          {captionsWindow.enabled || captionsWindow.open ? (
            <CommandItem
              value="Toggle captions reader"
              onSelect={() => run(() => toggleCaptionsWindow())}
            >
              <CaptionsIcon className="size-4" />
              {captionsWindow.open ? 'Close captions reader' : 'Open captions reader'}
              <CommandShortcut className="tracking-normal">
                <ShortcutKeys
                  accelerator={shortcutAccelerator('captions-window')}
                  platform={platform}
                />
              </CommandShortcut>
            </CommandItem>
          ) : null}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Theme">
          <CommandItem value="Theme light" onSelect={() => run(() => setTheme('light'))}>
            <LightModeIcon className="size-4" />
            Light
          </CommandItem>
          <CommandItem value="Theme dark" onSelect={() => run(() => setTheme('dark'))}>
            <DarkModeIcon className="size-4" />
            Dark
          </CommandItem>
          <CommandItem value="Theme system" onSelect={() => run(() => setTheme('system'))}>
            <DesktopIcon className="size-4" />
            System
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
