import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'

const CommandPalette = lazy(async () => ({
  default: (await import('@/components/command-palette')).CommandPalette
}))
import { Pane, PaneBody, Toolbar } from '@/components/pane'
import { Sidebar } from '@/components/sidebar'
import { StatusBar, StatusBarHint } from '@/components/status-bar'
import { StatusDot, type StatusDotTone } from '@/components/status-dot'
import {
  WORKSPACE_SHORTCUTS,
  WorkspaceNavContext,
  isStudioPanel,
  isWorkspaceTab,
  workspaceTabLabel,
  type StudioPanel,
  type WorkspaceTab
} from '@/components/workspace-nav'
import { useStudioAudio, useStudioCore, useStudioShell } from '@/hooks/use-studio'
import { StudioMicVisualProvider } from '@/hooks/use-studio-mic-visual'
import { useWhatsNew } from '@/hooks/use-whats-new'
import { ONBOARDING_DISMISSED_VALUE, STORAGE_KEYS } from '@/lib/capture'
import { displayKeyGlyph } from '@/lib/platform'
import {
  isSettingsTabId,
  readLastSettingsTab,
  writeLastSettingsTab,
  type SettingsTabId
} from '@/lib/settings-tabs'
import { isActiveRecordingState } from '@/lib/format'
import {
  isMediaAccessSnapshotReady,
  shouldShowPermissionsOnboarding,
  systemAccessRows
} from '@/lib/system-access'

// Workspace views are loaded only on first navigation, then retained by the
// browser module cache. Studio remains the launch surface, but its dashboard and
// heavier dependencies stay out of the shell's eager entry chunk.
const StudioTab = lazy(async () => ({
  default: (await import('@/components/tabs/studio-tab')).StudioTab
}))
const AiTab = lazy(async () => ({ default: (await import('@/components/tabs/ai-tab')).AiTab }))
const AssetsTab = lazy(async () => ({
  default: (await import('@/components/tabs/assets-tab')).AssetsTab
}))
const CaptionsTab = lazy(async () => ({
  default: (await import('@/components/tabs/captions-tab')).CaptionsTab
}))
const DiagnosticsTab = lazy(async () => ({
  default: (await import('@/components/tabs/diagnostics-tab')).DiagnosticsTab
}))
const loadLayoutTab = () => import('@/components/tabs/layout-tab')
const LayoutTab = lazy(async () => ({ default: (await loadLayoutTab()).LayoutTab }))
const LibraryTab = lazy(async () => ({
  default: (await import('@/components/tabs/library-tab')).LibraryTab
}))
const RecordingTab = lazy(async () => ({
  default: (await import('@/components/tabs/recording-tab')).RecordingTab
}))
const loadSettingsTab = () => import('@/components/tabs/settings-tab')
const SettingsTab = lazy(async () => ({ default: (await loadSettingsTab()).SettingsTab }))
const loadSourcesTab = () => import('@/components/tabs/sources-tab')
const SourcesTab = lazy(async () => ({ default: (await loadSourcesTab()).SourcesTab }))
const StreamingTab = lazy(async () => ({
  default: (await import('@/components/tabs/streaming-tab')).StreamingTab
}))
const PermissionsOnboardingDialog = lazy(async () => ({
  default: (await import('@/components/permissions-onboarding-dialog')).PermissionsOnboardingDialog
}))
const WhatsNewDialog = lazy(async () => ({
  default: (await import('@/components/whats-new-dialog')).WhatsNewDialog
}))

function WorkspaceTabFallback(): ReactElement {
  return (
    <div
      aria-live="polite"
      className="flex min-h-40 items-center justify-center text-xs text-muted-foreground"
      role="status"
    >
      Loading workspace…
    </div>
  )
}

function PermissionsOnboardingGate({
  open,
  onOpen,
  onComplete
}: {
  open: boolean
  onOpen: () => void
  onComplete: () => void
}): ReactElement {
  const { wsStatus, deviceList, mediaAccess, runtimeInfo } = useStudioCore()
  const { audioMeter } = useStudioAudio()
  const evaluatedRef = useRef(false)
  const dialogMountedRef = useRef(open)
  const backendReady = wsStatus === 'connected' && deviceList.devices.length > 0
  const mediaAccessReady = runtimeInfo !== null && isMediaAccessSnapshotReady(mediaAccess)

  if (open) {
    dialogMountedRef.current = true
  }

  useEffect(() => {
    if (evaluatedRef.current || !backendReady || !mediaAccessReady) {
      return
    }
    evaluatedRef.current = true
    const dismissed = localStorage.getItem(STORAGE_KEYS.onboarding) !== null
    const rows = systemAccessRows({
      deviceList,
      audioMeter,
      platform: runtimeInfo?.platform,
      mediaAccess
    })
    if (shouldShowPermissionsOnboarding({ rows, dismissed, backendReady, mediaAccessReady })) {
      onOpen()
    }
  }, [
    audioMeter,
    backendReady,
    deviceList,
    mediaAccess,
    mediaAccessReady,
    onOpen,
    runtimeInfo?.platform
  ])

  return (
    <Suspense fallback={null}>
      {dialogMountedRef.current ? (
        <PermissionsOnboardingDialog open={open} onComplete={onComplete} />
      ) : null}
    </Suspense>
  )
}

export function AppShell(): ReactElement {
  const {
    wsStatus,
    backendConnected,
    recordingState,
    runtimeInfo,
    entitlementTier,
    previewWindowOpen,
    togglePreviewWindow,
    notesWindowOpen,
    openNotesWindow,
    closeNotesWindow,
    commentsWindowOpen,
    openCommentsWindow,
    closeCommentsWindow,
    toggleCommentsWindow,
    toggleCaptionsWindow
  } = useStudioShell()
  const [active, setActive] = useState<WorkspaceTab>('studio')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [commandOpen, setCommandOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const whatsNew = useWhatsNew(runtimeInfo?.version, runtimeInfo?.platform)
  const modKey = displayKeyGlyph('⌘', runtimeInfo?.platform)
  const shiftKey = displayKeyGlyph('⇧', runtimeInfo?.platform)

  // Keep first paint Studio-only, then warm the three most common setup pages
  // from local app assets once Chromium is idle. Navigation stays instant
  // without putting these modules into the eager entry chunk.
  useEffect(() => {
    const prefetch = (): void => {
      void Promise.allSettled([loadSourcesTab(), loadLayoutTab(), loadSettingsTab()])
    }
    if (typeof window.requestIdleCallback === 'function') {
      const requestId = window.requestIdleCallback(prefetch, { timeout: 5000 })
      return () => window.cancelIdleCallback(requestId)
    }
    const timer = window.setTimeout(prefetch, 2000)
    return () => window.clearTimeout(timer)
  }, [])

  // Studio control pages are ordinary tabs grouped under "Studio" in the sidebar.
  const openStudioPanel = useCallback((panel: StudioPanel) => {
    setActive(panel)
  }, [])

  const closeStudioPanel = useCallback(() => {
    setActive('studio')
  }, [])

  // Plan 064: Settings reopens on the tab used last; a link that names a tab
  // (update chip, FFmpeg banner, ⌘K, toasts) selects it before opening.
  const [settingsTab, setSettingsTab] = useState<SettingsTabId>(readLastSettingsTab)
  const selectSettingsTab = useCallback((tab: SettingsTabId) => {
    setSettingsTab(tab)
    writeLastSettingsTab(tab)
  }, [])
  const openSettings = useCallback(
    (tab?: SettingsTabId) => {
      if (tab) {
        selectSettingsTab(tab)
      }
      setActive('settings')
    },
    [selectSettingsTab]
  )

  const completeOnboarding = useCallback(() => {
    localStorage.setItem(STORAGE_KEYS.onboarding, ONBOARDING_DISMISSED_VALUE)
    setOnboardingOpen(false)
  }, [])

  // Settings' "Set up permissions": force-open regardless of grants or the
  // dismissal flag — no flag clearing, closing just re-dismisses.
  const openPermissionsSetup = useCallback(() => {
    setOnboardingOpen(true)
  }, [])

  const openInAi = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId)
    setActive('ai')
  }, [])

  // D6: the post-recording toast funnels here; clearing the selection lets
  // Publish preselect the newest completed session (the one just saved).
  useEffect(() => {
    const onOpenPublish = (): void => {
      setSelectedSessionId(null)
      setActive('ai')
    }
    window.addEventListener('videorc:open-publish', onOpenPublish)
    return () => window.removeEventListener('videorc:open-publish', onOpenPublish)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setCommandOpen((value) => !value)
      }
      if (event.key.toLowerCase() === 'p' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void togglePreviewWindow()
      }
      if (
        runtimeInfo?.notesWindowEnabled &&
        event.key.toLowerCase() === 'n' &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        if (notesWindowOpen) {
          void closeNotesWindow()
        } else {
          void openNotesWindow()
        }
      }
      // Comments live ONLY in the separate window now (owner call,
      // 2026-08-19) — plain (cmd)J, which used to toggle the in-studio rail,
      // keeps working by toggling the window, same as (cmd)shift-J.
      if (
        runtimeInfo?.commentsWindowEnabled &&
        event.key.toLowerCase() === 'j' &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault()
        void toggleCommentsWindow()
      }
      if (event.key.toLowerCase() === 'c' && event.shiftKey && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void toggleCaptionsWindow()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [
    closeNotesWindow,
    notesWindowOpen,
    openNotesWindow,
    runtimeInfo?.commentsWindowEnabled,
    runtimeInfo?.notesWindowEnabled,
    toggleCommentsWindow,
    toggleCaptionsWindow,
    togglePreviewWindow
  ])

  // ⌘1–⌘9 / ⌘, arrive from the main process (Chromium swallows ⌘+digit before
  // the renderer keydown — see main's before-input-event handler). Map the raw
  // key to a page here, where navigation state lives. FX6: the IPC path
  // bypasses dialog focus entirely, so navigating behind an open modal has to
  // be gated here explicitly (ref — the subscription outlives renders).
  const modalOpenRef = useRef(false)
  modalOpenRef.current = onboardingOpen || whatsNew.open
  useEffect(() => {
    const off = window.videorc?.onShortcutNavigate?.((key) => {
      if (modalOpenRef.current) {
        return
      }
      const shortcut = WORKSPACE_SHORTCUTS.find((entry) => entry.digit === key)
      if (shortcut) {
        setActive(shortcut.tab)
      }
    })
    return off
  }, [])

  useEffect(() => {
    const onWorkspaceNavigate = (event: Event): void => {
      const detail = (event as CustomEvent<{ tab?: unknown; settingsTab?: unknown }>).detail
      const tab = detail?.tab
      if (tab === 'settings') {
        openSettings(isSettingsTabId(detail?.settingsTab) ? detail.settingsTab : undefined)
      } else if (isWorkspaceTab(tab)) {
        setActive(tab)
      }
    }
    window.addEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
    return () => window.removeEventListener('videorc:navigate-workspace', onWorkspaceNavigate)
  }, [openSettings])

  const live = isActiveRecordingState(recordingState)
  const statusTone: StatusDotTone = live
    ? 'error'
    : backendConnected
      ? 'good'
      : wsStatus === 'failed'
        ? 'error'
        : 'warn'
  const statusLabel = live ? recordingState : wsStatus

  return (
    <WorkspaceNavContext.Provider
      value={{
        active,
        setActive,
        activeStudioPanel: isStudioPanel(active) ? active : null,
        openStudioPanel,
        closeStudioPanel,
        openSettings
      }}
    >
      {/* The window family's shell (plan 050, D4): the sidebar sits on the
          window coat, the content pane adds --glass-content, and both share
          one 40 px header band with the traffic lights. Only PaneBody
          scrolls. */}
      <div
        className="flex h-screen overflow-hidden text-foreground"
        data-videorc-active-tab={active}
      >
        <Sidebar
          active={active}
          activeStudioPanel={isStudioPanel(active) ? active : null}
          accountTier={entitlementTier}
          onSelect={setActive}
          onSelectStudioPanel={openStudioPanel}
          onOpenSettings={openSettings}
          statusTone={statusTone}
          statusLabel={statusLabel}
          live={live}
          onOpenCommand={() => setCommandOpen(true)}
          platform={runtimeInfo?.platform}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-glass-content">
          <Pane>
            <Toolbar title={workspaceTabLabel(active)} />
            {/* Library manages its own scroll (pinned header and toolbar,
                  only the table scrolls), and so does Settings (its tab strip
                  stays pinned, only the tab under it scrolls); every other tab
                  scrolls as one. */}
            <PaneBody scroll={active !== 'library' && active !== 'settings'}>
              <StudioMicVisualProvider enabled={active === 'studio' || active === 'sources'}>
                <Suspense fallback={<WorkspaceTabFallback />}>
                  {active === 'studio' ? <StudioTab /> : null}
                  {active === 'sources' ? <SourcesTab /> : null}
                  {active === 'layouts' ? <LayoutTab /> : null}
                  {active === 'assets' ? <AssetsTab /> : null}
                  {active === 'live' ? <StreamingTab /> : null}
                  {active === 'captions' ? <CaptionsTab /> : null}
                  {active === 'recording' ? <RecordingTab /> : null}
                  {active === 'library' ? <LibraryTab onOpenInAi={openInAi} /> : null}
                  {active === 'ai' ? (
                    <AiTab
                      selectedSessionId={selectedSessionId}
                      setSelectedSessionId={setSelectedSessionId}
                    />
                  ) : null}
                  {active === 'diagnostics' ? <DiagnosticsTab /> : null}
                  {active === 'settings' ? (
                    <SettingsTab
                      tab={settingsTab}
                      onOpenPermissionsSetup={openPermissionsSetup}
                      onShowWhatsNew={whatsNew.showLatest}
                      onTabChange={selectSettingsTab}
                    />
                  ) : null}
                </Suspense>
              </StudioMicVisualProvider>
            </PaneBody>
          </Pane>
          {/* State on the left, the shell's real shortcuts on the right:
                keyboard-first, only quieter than the old footer bar. */}
          <StatusBar leading={<StatusDot label={statusLabel} pulse={live} tone={statusTone} />}>
            <StatusBarHint
              keys={`${modKey}K`}
              label="Search"
              onClick={() => setCommandOpen(true)}
            />
            <StatusBarHint
              keys={`${modKey}P`}
              label="Preview"
              pressed={previewWindowOpen}
              onClick={() => void togglePreviewWindow()}
            />
            {/* Flags default ON and runtimeInfo lands async: treating null as
                  enabled keeps the bar at its final width from the first paint. */}
            {runtimeInfo?.notesWindowEnabled !== false ? (
              <StatusBarHint
                keys={`${shiftKey}${modKey}N`}
                label="Notes"
                pressed={notesWindowOpen}
                onClick={() => (notesWindowOpen ? void closeNotesWindow() : void openNotesWindow())}
              />
            ) : null}
            {runtimeInfo?.commentsWindowEnabled !== false ? (
              <StatusBarHint
                keys={`${shiftKey}${modKey}J`}
                label="Stream Manager"
                pressed={commentsWindowOpen}
                onClick={() =>
                  commentsWindowOpen ? void closeCommentsWindow() : void openCommentsWindow()
                }
              />
            ) : null}
          </StatusBar>
        </main>

        <Suspense fallback={null}>
          {commandOpen ? <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} /> : null}
        </Suspense>
        <PermissionsOnboardingGate
          open={onboardingOpen}
          onOpen={openPermissionsSetup}
          onComplete={completeOnboarding}
        />
        {/* Post-update highlights; suppressed behind onboarding on first run
            (first run initializes the last-seen version silently). */}
        <Suspense fallback={null}>
          {whatsNew.open && !onboardingOpen ? (
            <WhatsNewDialog entry={whatsNew.entry} open onClose={whatsNew.dismiss} />
          ) : null}
        </Suspense>
      </div>
    </WorkspaceNavContext.Provider>
  )
}
