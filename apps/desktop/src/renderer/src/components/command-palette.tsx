import {
  CaptionsIcon,
  ChatIcon,
  ClipIcon,
  DarkModeIcon,
  DesktopIcon,
  ImageIcon,
  LightModeIcon,
  LivestreamIcon,
  BuddyIcon,
  NoteIcon,
  PreviewIcon,
  RecordIcon,
  SceneIcon,
  SettingsIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  StopIcon,
  TerminalIcon
} from '@/components/icons'
import { useTheme } from 'next-themes'
import { useState, type ReactElement, type ReactNode } from 'react'

import {
  CommandDialog,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut
} from '@/components/ui/command'
import { ShortcutKeys } from '@/components/ui/shortcut-keys'
import { LONG_CLIP_SECONDS } from '../../../shared/clip-marks'
import { BUDDY_TABS, type BuddyTabId } from '@/lib/buddy-tabs'
import { firstRunReplayLocked } from '@/lib/first-run'
import { GO_LIVE_COMMAND, START_RECORDING_COMMAND } from '@/lib/go-live-copy'
import { HEALTH_SEARCH_KEYWORDS } from '@/lib/health-door'
import { openLivestreamView } from '@/lib/livestream-tabs'
import { SETTINGS_TABS, type SettingsTabId } from '@/lib/settings-tabs'
import { shortcutAccelerator } from '@/lib/shortcuts'
import { sessionStopControl } from '@/lib/studio-session-view'
import { studioChatOn } from '@/lib/studio-chat'
import { toastUserError } from '@/lib/user-error'
import { openFirstRunSetup } from '@/lib/workspace-navigation'
import {
  STUDIO_PANELS,
  WORKSPACE_TABS,
  isStudioPanel,
  shortcutDigitFor,
  useWorkspaceNav,
  type WorkspaceTab,
  type WorkspaceTabGroup
} from '@/components/workspace-nav'
import { useAgents, useAgentsActions } from '@/hooks/use-agents'
import { useSoundboard } from '@/hooks/use-soundboard'
import { CONNECT_AGENT_COMMAND, STOP_AGENTS_COMMAND } from '@/lib/agents-view'
import {
  useStudioBanners,
  useStudioCore,
  useStudioRecordingState,
  useStudioReplay
} from '@/hooks/use-studio'
import { sessionIsReplayOnly } from '../../../shared/capture-state'
import { WINDOW_NAMES } from '../../../shared/window-names'

// ⌘K (plan 174 S3.21, A-9, A-13): Session first (the transport's own
// actions), then every page with one verb, the windows, the saved scenes,
// the banners (plan 186), the sounds (plan 189), Buddy's and Settings' tabs, and the look. Each
// item's value is the words the footer shows for it, and its keywords are what people type instead.

/** What people type for a page that is not its name. */
export const PAGE_KEYWORDS: Readonly<Record<WorkspaceTab, readonly string[]>> = {
  studio: ['record', 'go live', 'stage', 'transport'],
  ai: ['companion', 'ai', 'chat', 'voice', 'reports', 'clean cut'],
  sources: ['camera', 'microphone', 'screen', 'window', 'devices', 'audio', 'mixer'],
  layouts: ['layout', 'layouts', 'composition', 'background', 'takeover', 'presets'],
  assets: ['backgrounds', 'overlays', 'images', 'takeovers', 'banners', 'sounds', 'soundboard'],
  live: ['destinations', 'stream key', 'youtube', 'twitch', 'kick', 'schedule', 'go live'],
  captions: ['subtitles', 'transcription'],
  recording: ['recording', 'quality', 'resolution', 'folder', 'file', 'storage'],
  library: ['recordings', 'clips', 'markers', 'history'],
  settings: ['preferences', 'keyboard', 'shortcuts', 'permissions', 'updates', 'about'],
  diagnostics: HEALTH_SEARCH_KEYWORDS
}

const SETTINGS_KEYWORDS: Readonly<Record<SettingsTabId, readonly string[]>> = {
  general: ['theme', 'startup', 'animate', 'preferences'],
  permissions: ['camera access', 'screen recording', 'microphone access', 'system access'],
  shortcuts: ['keyboard', 'keys', 'hotkeys', 'bindings'],
  remote: ['phone', 'stream deck', 'pair', 'control', 'agents', 'ai', 'mcp'],
  about: ['version', 'update', 'release notes', 'support bundle']
}

const BUDDY_KEYWORDS: Readonly<Record<BuddyTabId, readonly string[]>> = {
  live: ['profile', 'persona', 'buddy live', 'status'],
  chat: ['posting', 'suggest', 'auto', 'moderation'],
  voice: ['commands', 'speak', 'listen'],
  reports: ['summary', 'stream report'],
  'clean-cut': ['edit', 'export', 'cut', 'recording']
}

const tabsIn = (group: WorkspaceTabGroup): typeof WORKSPACE_TABS =>
  WORKSPACE_TABS.filter((tab) => tab.group === group)

/** Every page in sidebar order, Health (no row) last. */
const PAGES = [...tabsIn('stage'), ...STUDIO_PANELS, ...tabsIn('library'), ...tabsIn('system')]

/** A row's secondary context, after its title. */
function Context({ children }: { children: ReactNode }): ReactElement {
  return <span className="truncate text-muted-foreground">{children}</span>
}

/** ⌘K command palette: jump anywhere + run the core session/theme actions. Open state is
 *  owned by the shell so the sidebar trigger and the global shortcut share it. */
export function CommandPalette({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): ReactElement {
  const { active, setActive, openStudioPanel, openSettings, openBuddy } = useWorkspaceNav()
  const {
    runtimeInfo,
    savedScenes,
    applySavedSceneResult,
    captureConfig,
    setCaptureConfig,
    settings,
    setSettings,
    markClip,
    startRecording,
    startLivestream,
    requestStopSession,
    previewWindow,
    togglePreviewWindow,
    notesWindow,
    openNotesWindow,
    closeNotesWindow,
    commentsWindow,
    toggleCommentsWindow,
    captionsWindow,
    toggleCaptionsWindow
  } = useStudioCore()
  const { recording } = useStudioRecordingState()
  const replayBuffer = useStudioReplay()
  const { banners, showBanner, hideBanner } = useStudioBanners()
  const soundboard = useSoundboard()
  const agents = useAgents()
  const agentsActions = useAgentsActions()
  const platform = runtimeInfo?.platform
  const { theme, setTheme } = useTheme()
  // cmdk's selected item; the footer names it.
  const [selected, setSelected] = useState('')

  const run = (action: () => void | Promise<void>): void => {
    onOpenChange(false)
    void action()
  }

  // Running, not starting: while a start is in flight the two starts stay,
  // disabled, so the row the streamer reached for does not change under
  // the cursor. A buffer-only session (plan 181) owns no transport: the two
  // starts stay, and "Stop recording" never names the ring.
  const live =
    (recording.state === 'recording' || recording.state === 'streaming') &&
    !sessionIsReplayOnly(recording)
  const busy = recording.state === 'starting' || recording.state === 'stopping'
  // The transport's own stop words (plan 174 D3): "End livestream" on air,
  // "Stop recording" for a recording.
  const stopLabel = sessionStopControl(recording, false).label
  const microphoneMuted = captureConfig.audio.microphoneMuted
  const muteLabel = microphoneMuted ? 'Unmute microphone' : 'Mute microphone'
  const MuteIcon = microphoneMuted ? SpeakerOnIcon : SpeakerOffIcon

  const openPage = (id: WorkspaceTab): void => {
    if (isStudioPanel(id)) openStudioPanel(id)
    else if (id === 'settings') openSettings()
    else if (id === 'ai') openBuddy()
    else setActive(id)
  }

  const shortcut = (accelerator: string | undefined): ReactNode =>
    accelerator ? (
      <CommandShortcut className="tracking-normal">
        <ShortcutKeys accelerator={accelerator} platform={platform} />
      </CommandShortcut>
    ) : null

  return (
    <CommandDialog
      open={open}
      value={selected}
      onOpenChange={onOpenChange}
      onValueChange={setSelected}
    >
      <CommandInput placeholder="Search commands…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {/* The transport's two starts and its stop, in its words (plan 174
            D3): "Start recording" and "Go live…", then "Stop recording" or
            "End livestream"; the mute and the clip mark beside them. */}
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
              {shortcut(shortcutAccelerator('record-toggle'))}
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
                {shortcut(shortcutAccelerator('record-toggle'))}
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
          <CommandItem
            value={muteLabel}
            keywords={['mic', 'microphone', 'audio', 'mute', 'silence']}
            onSelect={() =>
              run(() =>
                setCaptureConfig((current) => ({
                  ...current,
                  audio: { ...current.audio, microphoneMuted: !current.audio.microphoneMuted }
                }))
              )
            }
          >
            <MuteIcon className="size-4" />
            {muteLabel}
            {shortcut(settings.globalShortcuts?.micToggle)}
          </CommandItem>
          {/* The one clip action (plan 181 R4): the last seconds whenever the
              ring holds frames, and a mark in the recording while one runs.
              Plan 199: two lengths, 30 seconds and the minute. */}
          {live || replayBuffer.state.state === 'on' ? (
            <>
              <CommandItem
                value="Save a 30-second clip"
                keywords={['clip', 'replay', 'marker', 'moment', '30', 'seconds']}
                onSelect={() => run(() => void markClip())}
              >
                <ClipIcon className="size-4" />
                Save a 30-second clip
                {shortcut(settings.globalShortcuts?.clipMark)}
              </CommandItem>
              <CommandItem
                value="Save a 1-minute clip"
                keywords={['clip', 'replay', 'marker', 'moment', '60', 'minute', 'long']}
                onSelect={() => run(() => void markClip(LONG_CLIP_SECONDS))}
              >
                <ClipIcon className="size-4" />
                Save a 1-minute clip
                {shortcut(settings.globalShortcuts?.clipMarkLong)}
              </CommandItem>
            </>
          ) : null}
          {/* Plan 209 D12: every agent cut and Agents off, from anywhere. */}
          {agents.status?.enabled ? (
            <CommandItem
              value={STOP_AGENTS_COMMAND}
              keywords={['agents', 'ai', 'mcp', 'claude', 'cursor', 'codex', 'disconnect', 'off']}
              onSelect={() =>
                run(async () => {
                  try {
                    await agentsActions.stop()
                  } catch (error) {
                    toastUserError(error, { action: 'stop', object: 'the agents' })
                  }
                })
              }
            >
              <StopIcon className="size-4" />
              {STOP_AGENTS_COMMAND}
            </CommandItem>
          ) : null}
        </CommandGroup>

        <CommandSeparator />

        {/* One verb for every page, in sidebar order. Health is out of the
            sidebar (plan 174 D9): ⌘K finds it by what people look for there. */}
        <CommandGroup heading="Pages">
          {PAGES.map((page) => {
            const digit = shortcutDigitFor(page.id)
            return (
              <CommandItem
                key={page.id}
                value={`Open ${page.label}`}
                keywords={[...PAGE_KEYWORDS[page.id]]}
                onSelect={() => run(() => openPage(page.id))}
              >
                <page.icon className="size-4" />
                {page.label}
                {shortcut(digit ? `CmdOrCtrl+${digit}` : undefined)}
              </CommandItem>
            )
          })}
          <CommandItem
            value="Open Upcoming events"
            keywords={['schedule', 'livestream', 'events', 'calendar']}
            onSelect={() => run(() => openLivestreamView('upcoming'))}
          >
            <LivestreamIcon className="size-4" />
            Upcoming events
            <Context>Livestream</Context>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        {/* Every window by its one name (plan 174 S2.3a, A-11), in the
            Window menu's order. */}
        <CommandGroup heading="Windows">
          <CommandItem
            value={
              previewWindow.open ? `Close ${WINDOW_NAMES.preview}` : `Open ${WINDOW_NAMES.preview}`
            }
            keywords={['monitor', 'stage', 'window']}
            onSelect={() => run(togglePreviewWindow)}
          >
            <PreviewIcon className="size-4" />
            {previewWindow.open ? `Close ${WINDOW_NAMES.preview}` : `Open ${WINDOW_NAMES.preview}`}
            {shortcut(shortcutAccelerator('preview-window'))}
          </CommandItem>
          {runtimeInfo?.notesWindowEnabled !== false ? (
            <CommandItem
              value={
                notesWindow.open ? `Close ${WINDOW_NAMES.notes}` : `Open ${WINDOW_NAMES.notes}`
              }
              keywords={['script', 'teleprompter', 'window']}
              onSelect={() => run(notesWindow.open ? closeNotesWindow : openNotesWindow)}
            >
              <NoteIcon className="size-4" />
              {notesWindow.open ? `Close ${WINDOW_NAMES.notes}` : `Open ${WINDOW_NAMES.notes}`}
              {shortcut(shortcutAccelerator('notes-window'))}
            </CommandItem>
          ) : null}
          {runtimeInfo?.commentsWindowEnabled ? (
            <CommandItem
              value={
                commentsWindow.open
                  ? `Close ${WINDOW_NAMES.streamManager}`
                  : `Open ${WINDOW_NAMES.streamManager}`
              }
              keywords={['chat', 'comments', 'activity', 'viewers', 'window', 'buddy']}
              onSelect={() => run(() => toggleCommentsWindow())}
            >
              <ChatIcon className="size-4" />
              {commentsWindow.open
                ? `Close ${WINDOW_NAMES.streamManager}`
                : `Open ${WINDOW_NAMES.streamManager}`}
              {shortcut(shortcutAccelerator('comments-window'))}
            </CommandItem>
          ) : null}
          {captionsWindow.enabled || captionsWindow.open ? (
            <CommandItem
              value={
                captionsWindow.open
                  ? `Close ${WINDOW_NAMES.captions}`
                  : `Open ${WINDOW_NAMES.captions}`
              }
              keywords={['subtitles', 'window', 'reader']}
              onSelect={() => run(() => toggleCaptionsWindow())}
            >
              <CaptionsIcon className="size-4" />
              {captionsWindow.open
                ? `Close ${WINDOW_NAMES.captions}`
                : `Open ${WINDOW_NAMES.captions}`}
              {shortcut(shortcutAccelerator('captions-window'))}
            </CommandItem>
          ) : null}
        </CommandGroup>

        {savedScenes.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Scenes">
              {savedScenes.map((scene) => (
                <CommandItem
                  key={scene.id}
                  value={`Switch to ${scene.name}`}
                  keywords={['scene', 'layout']}
                  onSelect={() =>
                    run(async () => {
                      await applySavedSceneResult(scene.id)
                    })
                  }
                >
                  <SceneIcon className="size-4" />
                  {scene.name}
                  <Context>Saved scene</Context>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {/* Plan 186 S7: each banner by its verb now, then Hide all banners
            while any shows. The picture is the confirmation. */}
        {banners.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Banners">
              {banners.map((banner) => {
                const label = `${banner.shown ? 'Hide' : 'Show'} banner: ${banner.name}`
                return (
                  <CommandItem
                    key={banner.id}
                    value={label}
                    keywords={['banner', 'sponsor', 'logo', 'image', 'overlay']}
                    onSelect={() =>
                      run(() => void (banner.shown ? hideBanner(banner.id) : showBanner(banner.id)))
                    }
                  >
                    <ImageIcon className="size-4" />
                    {label}
                  </CommandItem>
                )
              })}
              {banners.some((banner) => banner.shown) ? (
                <CommandItem
                  value="Hide all banners"
                  keywords={['banners', 'off', 'clear', 'remove']}
                  onSelect={() => run(() => void hideBanner())}
                >
                  <ImageIcon className="size-4" />
                  Hide all banners
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}

        {/* Plan 189 S10: each sound, with its Studio key, then Stop all sounds
            while any plays. The pad's ring is the confirmation. */}
        {soundboard.sounds.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sounds">
              {soundboard.sounds.map((sound) => {
                const label = `Play sound: ${sound.name}`
                return (
                  <CommandItem
                    key={sound.id}
                    value={label}
                    keywords={['sound', 'soundboard', 'sfx', 'effect', 'play']}
                    onSelect={() => run(() => void soundboard.play(sound.id))}
                  >
                    <SpeakerOnIcon className="size-4" />
                    {label}
                    {shortcut(sound.hotkey)}
                  </CommandItem>
                )
              })}
              {soundboard.voices.length ? (
                <CommandItem
                  value="Stop all sounds"
                  keywords={['sounds', 'soundboard', 'stop', 'silence']}
                  onSelect={() => run(() => void soundboard.stopAll())}
                >
                  <StopIcon className="size-4" />
                  Stop all sounds
                </CommandItem>
              ) : null}
            </CommandGroup>
          </>
        ) : null}

        <CommandSeparator />

        {/* Plan 150: every Buddy tab is one jump away, like Settings'. */}
        <CommandGroup heading="Buddy">
          {BUDDY_TABS.map((tab) => (
            <CommandItem
              key={tab.id}
              value={`Open Buddy → ${tab.label}`}
              keywords={[...BUDDY_KEYWORDS[tab.id]]}
              onSelect={() => run(() => openBuddy(tab.id))}
            >
              <BuddyIcon className="size-4" />
              {tab.label}
              <Context>Buddy</Context>
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
              value={`Open Settings → ${tab.label}`}
              keywords={[...SETTINGS_KEYWORDS[tab.id]]}
              onSelect={() => run(() => openSettings(tab.id))}
            >
              <SettingsIcon className="size-4" />
              {tab.label}
              <Context>Settings</Context>
              {tab.id === 'shortcuts' ? shortcut(shortcutAccelerator('shortcuts-page')) : null}
            </CommandItem>
          ))}
          {/* Plan 209 S7: Settings → Remote at Agents, with the dialog open. */}
          <CommandItem
            value={CONNECT_AGENT_COMMAND}
            keywords={['agent', 'ai', 'mcp', 'claude', 'cursor', 'codex', 'vs code', 'connect']}
            onSelect={() =>
              run(() => {
                openSettings('remote')
                agentsActions.openConnect()
              })
            }
          >
            <TerminalIcon className="size-4" />
            {CONNECT_AGENT_COMMAND}
            <Context>Settings → Remote</Context>
          </CommandItem>
          {/* Plan 203 S6: setup again, back to this page after. Setup holds
              capture back, so a session hides it (Settings says why). */}
          {firstRunReplayLocked(recording) ? null : (
            <CommandItem
              value="Run setup again…"
              keywords={['first-run', 'welcome', 'onboarding', 'permissions', 'setup']}
              onSelect={() => run(() => openFirstRunSetup({ returnTo: active }))}
            >
              <SettingsIcon className="size-4" />
              Run setup again…
              <Context>Settings</Context>
            </CommandItem>
          )}
        </CommandGroup>

        <CommandSeparator />

        {/* The look in use wears the check (plan 174 A-9). */}
        <CommandGroup heading="Appearance">
          <CommandItem
            value="Light theme"
            keywords={['theme', 'appearance', 'mode']}
            data-checked={theme === 'light'}
            onSelect={() => run(() => setTheme('light'))}
          >
            <LightModeIcon className="size-4" />
            Light
          </CommandItem>
          <CommandItem
            value="Dark theme"
            keywords={['theme', 'appearance', 'mode']}
            data-checked={theme === 'dark'}
            onSelect={() => run(() => setTheme('dark'))}
          >
            <DarkModeIcon className="size-4" />
            Dark
          </CommandItem>
          <CommandItem
            value="System theme"
            keywords={['theme', 'appearance', 'mode', 'automatic']}
            data-checked={theme === 'system'}
            onSelect={() => run(() => setTheme('system'))}
          >
            <DesktopIcon className="size-4" />
            System
          </CommandItem>
          {/* Chat in Studio (plan 204): a mirror of Settings → General →
              Chat, checked while on. */}
          <CommandItem
            value="Chat in Studio"
            keywords={['chat', 'comments', 'messages', 'studio']}
            data-checked={studioChatOn(settings)}
            onSelect={() =>
              run(() =>
                setSettings((current) => ({ ...current, studioChat: !studioChatOn(current) }))
              )
            }
          >
            <ChatIcon className="size-4" />
            Chat in Studio
          </CommandItem>
        </CommandGroup>
      </CommandList>
      {/* The selected action and the key that runs it. The list already
          announces the selection, so the footer is decoration. */}
      <CommandFooter aria-hidden>
        <span className="min-w-0 truncate">{selected}</span>
        <ShortcutKeys accelerator="Enter" className="shrink-0" platform={platform} />
      </CommandFooter>
    </CommandDialog>
  )
}
